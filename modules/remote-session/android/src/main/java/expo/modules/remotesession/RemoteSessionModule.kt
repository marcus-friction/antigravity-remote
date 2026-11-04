package expo.modules.remotesession

import android.os.Build
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

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      mainHandler.post(block)
    }
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

  private fun applyWebViewKeepAlivePolicy(protectInBackground: Boolean, wakeTimers: Boolean = false) {
    val activity = appContext.currentActivity ?: return
    val webView = findWebView(activity.window?.decorView) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.setRendererPriorityPolicy(
        WebView.RENDERER_PRIORITY_IMPORTANT,
        /* waivedWhenNotVisible = */ !protectInBackground
      )
    }
    if (wakeTimers) {
      webView.onResume()
      webView.resumeTimers()
    }
  }

  private fun stopKeepAliveServiceIfRunning() {
    val context = appContext.reactContext ?: return
    RemoteKeepAliveService.stop(context)
  }

  override fun definition() = ModuleDefinition {
    Name("RemoteSession")

    OnCreate {
      RemoteKeepAliveService.onUserStoppedCallback = {
        stoppedForCurrentBackgroundStay = true
        runOnMain {
          applyWebViewKeepAlivePolicy(protectInBackground = false)
        }
      }
    }

    AsyncFunction("clearWebData") { promise: Promise ->
      try {
        sessionActive = false
        stoppedForCurrentBackgroundStay = false
        stopKeepAliveServiceIfRunning()
        applyWebViewKeepAlivePolicy(protectInBackground = false)

        val context = appContext.reactContext ?: throw IllegalStateException("Application unavailable")
        WebView(context).apply { clearCache(true); destroy() }
        val storage = WebStorage.getInstance()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
          WebStorageCompat.deleteBrowsingData(storage) { promise.resolve(null) }
        } else {
          // Legacy WebViews expose no completion callback for DOM storage removal.
          storage.deleteAllData()
          promise.resolve(null)
        }
      } catch (error: Exception) {
        promise.reject("ERR_WEB_DATA_CLEANUP", "Unable to clear website data", error)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("configureKeepAlive") { enabled: Boolean, durationMinutes: Int, active: Boolean ->
      keepAliveEnabled = enabled
      keepAliveMinutes = durationMinutes.coerceIn(0, 60)
      sessionActive = active

      val keepAlive = shouldKeepAlive()
      applyWebViewKeepAlivePolicy(protectInBackground = keepAlive)
      if (!keepAlive) {
        stopKeepAliveServiceIfRunning()
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersBackground {
      runOnMain {
        if (shouldKeepAlive() && !stoppedForCurrentBackgroundStay) {
          applyWebViewKeepAlivePolicy(protectInBackground = true)
          val context = appContext.reactContext
          if (context != null) {
            RemoteKeepAliveService.start(context, keepAliveMinutes)
          }
        } else {
          applyWebViewKeepAlivePolicy(protectInBackground = false)
          stopKeepAliveServiceIfRunning()
        }
      }
    }

    OnActivityEntersForeground {
      stoppedForCurrentBackgroundStay = false
      runOnMain {
        stopKeepAliveServiceIfRunning()
        applyWebViewKeepAlivePolicy(
          protectInBackground = shouldKeepAlive(),
          wakeTimers = true
        )
      }
    }

    OnActivityDestroys {
      stopKeepAliveServiceIfRunning()
    }

    OnDestroy {
      RemoteKeepAliveService.onUserStoppedCallback = null
      stopKeepAliveServiceIfRunning()
    }
  }
}
