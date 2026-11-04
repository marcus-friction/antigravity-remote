package expo.modules.remotesession

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RemoteSessionModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  @Volatile private var keepAliveEnabled: Boolean = true
  @Volatile private var keepAliveMinutes: Int = 30
  @Volatile private var sessionActive: Boolean = false
  @Volatile private var stoppedForCurrentBackgroundStay: Boolean = false
  private var registeredApplication: Application? = null

  private val activityLifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityStarted(activity: Activity) {
      val current = appContext.currentActivity
      if (current != null && activity !== current) return
      stoppedForCurrentBackgroundStay = false
      runOnMain {
        stopKeepAliveServiceIfRunning()
        applyWebViewKeepAlivePolicy(
          protectInBackground = shouldKeepAlive(),
          wakeTimers = true,
          hostActivity = activity
        )
      }
    }

    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) {
      // Ignore configuration changes (e.g. screen rotation) and unrelated activities;
      // unlike Activity.onPause, onStop only runs when the window is no longer visible
      // (avoiding permission-dialog and split-screen focus churn).
      if (activity.isChangingConfigurations) return
      val current = appContext.currentActivity
      if (current != null && activity !== current) return
      runOnMain {
        if (shouldKeepAlive() && !stoppedForCurrentBackgroundStay) {
          applyWebViewKeepAlivePolicy(
            protectInBackground = true,
            hostActivity = activity
          )
          val context = appContext.reactContext ?: activity.applicationContext
          if (!RemoteKeepAliveService.start(context, keepAliveMinutes)) {
            applyWebViewKeepAlivePolicy(
              protectInBackground = false,
              releaseWebLock = true,
              hostActivity = activity
            )
          }
        } else {
          applyWebViewKeepAlivePolicy(
            protectInBackground = false,
            releaseWebLock = true,
            hostActivity = activity
          )
          stopKeepAliveServiceIfRunning()
        }
      }
    }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
  }

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      mainHandler.post(block)
    }
  }

  private fun registerActivityLifecycleObserverIfNeeded() {
    if (registeredApplication != null) return
    val app = (appContext.reactContext?.applicationContext ?: appContext.currentActivity?.application)
      as? Application ?: return
    app.registerActivityLifecycleCallbacks(activityLifecycleCallbacks)
    registeredApplication = app
  }

  private fun unregisterActivityLifecycleObserver() {
    registeredApplication?.unregisterActivityLifecycleCallbacks(activityLifecycleCallbacks)
    registeredApplication = null
  }

  private fun findWebView(root: View?): WebView? {
    if (root == null) return null
    if (root is WebView) return root
    if (root is ViewGroup) {
      for (i in 0 until root.childCount) {
        val found = findWebView(root.getChildAt(i))
        if (found != null) return found
      }
    }
    return null
  }

  private fun shouldKeepAlive(): Boolean {
    return keepAliveEnabled && keepAliveMinutes > 0 && sessionActive
  }

  private fun applyWebViewKeepAlivePolicy(
    protectInBackground: Boolean,
    wakeTimers: Boolean = false,
    releaseWebLock: Boolean = false,
    hostActivity: Activity? = null
  ) {
    val activity = hostActivity ?: appContext.currentActivity ?: return
    val webView = findWebView(activity.window?.decorView) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.setRendererPriorityPolicy(
        WebView.RENDERER_PRIORITY_IMPORTANT,
        /* waivedWhenNotVisible = */ !protectInBackground
      )
    }
    if (releaseWebLock) {
      webView.evaluateJavascript(RELEASE_WEB_LOCK_SCRIPT, null)
    }
    if (wakeTimers) {
      webView.onResume()
      webView.resumeTimers()
    }
  }

  private fun stopKeepAliveServiceIfRunning() {
    val context = appContext.reactContext ?: appContext.currentActivity?.applicationContext ?: return
    RemoteKeepAliveService.stop(context)
  }

  override fun definition() = ModuleDefinition {
    Name("RemoteSession")

    OnCreate {
      registerActivityLifecycleObserverIfNeeded()
      RemoteKeepAliveService.registerKeepAliveEndedListener(this@RemoteSessionModule) { stoppedByUser ->
        if (stoppedByUser) {
          stoppedForCurrentBackgroundStay = true
        }
        runOnMain {
          applyWebViewKeepAlivePolicy(
            protectInBackground = false,
            releaseWebLock = true
          )
        }
      }
    }

    AsyncFunction("clearWebData") { promise: Promise ->
      try {
        sessionActive = false
        stoppedForCurrentBackgroundStay = false
        stopKeepAliveServiceIfRunning()
        applyWebViewKeepAlivePolicy(
          protectInBackground = false,
          releaseWebLock = true
        )

        val context = appContext.reactContext ?: throw IllegalStateException("Application unavailable")
        WebView(context).apply { clearCache(true); destroy() }
        val storage = WebStorage.getInstance()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
          WebStorageCompat.deleteBrowsingData(storage, Runnable::run) { promise.resolve(null) }
        } else {
          storage.deleteAllData()
          promise.resolve(null)
        }
      } catch (error: Throwable) {
        promise.reject("ERR_WEB_DATA_CLEANUP", "Unable to clear website data", error)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("configureKeepAlive") { enabled: Boolean, durationMinutes: Int, active: Boolean ->
      registerActivityLifecycleObserverIfNeeded()
      keepAliveEnabled = enabled
      keepAliveMinutes = durationMinutes.coerceIn(0, 60)
      sessionActive = active

      val keepAlive = shouldKeepAlive()
      applyWebViewKeepAlivePolicy(
        protectInBackground = keepAlive,
        releaseWebLock = !keepAlive
      )
      if (!keepAlive) {
        stopKeepAliveServiceIfRunning()
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground {
      stoppedForCurrentBackgroundStay = false
      runOnMain {
        registerActivityLifecycleObserverIfNeeded()
        stopKeepAliveServiceIfRunning()
        applyWebViewKeepAlivePolicy(
          protectInBackground = shouldKeepAlive(),
          wakeTimers = true
        )
      }
    }

    OnActivityDestroys {
      val activity = appContext.currentActivity
      if (activity == null || !activity.isChangingConfigurations) {
        stopKeepAliveServiceIfRunning()
      }
    }

    OnDestroy {
      unregisterActivityLifecycleObserver()
      RemoteKeepAliveService.unregisterKeepAliveEndedListener(this@RemoteSessionModule)
      stopKeepAliveServiceIfRunning()
    }
  }

  companion object {
    private const val RELEASE_WEB_LOCK_SCRIPT =
      "(function(){try{window.__agyKeepAliveLockDesired=false;if(typeof window.__agyReleaseKeepAliveLock==='function'){window.__agyReleaseKeepAliveLock();}window.__agyKeepAliveLockHeld=false;}catch(_){}})();"
  }
}
