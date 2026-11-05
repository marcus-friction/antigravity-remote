package expo.modules.remotesession

import android.app.Activity
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import java.lang.ref.WeakReference
import java.util.WeakHashMap
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RemoteSessionModule : Module() {
  private data class InstalledDocumentStartScript(
    val script: String,
    val handler: ScriptHandler
  )

  private val mainHandler = Handler(Looper.getMainLooper())
  @Volatile private var keepAliveEnabled: Boolean = false
  @Volatile private var keepAliveMinutes: Int = 0
  @Volatile private var sessionActive: Boolean = false
  @Volatile private var stoppedForCurrentBackgroundStay: Boolean = false
  @Volatile private var desiredDocumentStartScript: String? = null
  private var registeredApplication: Application? = null
  private var cachedWebViewRef: WeakReference<WebView>? = null
  private val observedDecorViews = WeakHashMap<View, View.OnLayoutChangeListener>()
  private val installedDocumentStartScripts =
    WeakHashMap<WebView, InstalledDocumentStartScript>()
  private val retryInstallDocumentStartRunnable = Runnable {
    applyDocumentStartScriptIfNeeded()
  }

  private val activityLifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityStarted(activity: Activity) {
      val current = appContext.currentActivity
      if (current != null && activity !== current) return
      stoppedForCurrentBackgroundStay = false
      runOnMain {
        stopKeepAliveServiceIfRunning()
        applyDrawerGestureExclusion(activity)
        applyDocumentStartScriptIfNeeded(activity)
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
    override fun onActivityDestroyed(activity: Activity) {
      val decorView = activity.window?.decorView ?: return
      runOnMain {
        observedDecorViews.remove(decorView)?.let { listener ->
          decorView.removeOnLayoutChangeListener(listener)
        }
      }
    }
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

  private fun resolveWebView(root: View?): WebView? {
    val cached = cachedWebViewRef?.get()
    if (cached != null && cached.isAttachedToWindow && cached.parent != null) {
      return cached
    }
    val found = findWebView(root)
    cachedWebViewRef = if (found != null) WeakReference(found) else null
    return found
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
    val webView = resolveWebView(activity.window?.decorView) ?: return
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

  private fun applyDrawerGestureExclusion(hostActivity: Activity? = null) {
    val activity = hostActivity ?: appContext.currentActivity ?: return
    val decorView = activity.window?.decorView ?: return

    fun updateExclusionRects(view: View) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
      val height = view.height
      if (height <= 0) return
      val density = view.resources.displayMetrics.density
      val halfZonePx = (74f * density).toInt()
      val edgeWidthPx = (48f * density).toInt()
      val centerY = height / 2
      view.systemGestureExclusionRects = listOf(
        Rect(
          0,
          (centerY - halfZonePx).coerceAtLeast(0),
          edgeWidthPx,
          (centerY + halfZonePx).coerceAtMost(height)
        )
      )
    }

    if (!observedDecorViews.containsKey(decorView)) {
      val listener = View.OnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
        updateExclusionRects(v)
        applyDocumentStartScriptIfNeeded(activity)
      }
      observedDecorViews[decorView] = listener
      decorView.addOnLayoutChangeListener(listener)
    }
    decorView.post {
      updateExclusionRects(decorView)
      applyDocumentStartScriptIfNeeded(activity)
    }
  }

  private fun applyDocumentStartScriptIfNeeded(hostActivity: Activity? = null): Boolean {
    val script = desiredDocumentStartScript
    if (script.isNullOrEmpty()) {
      removeInstalledDocumentStartScripts()
      return false
    }
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      return false
    }
    val activity = hostActivity ?: appContext.currentActivity ?: return false
    val webView = resolveWebView(activity.window?.decorView) ?: return false
    val existing = installedDocumentStartScripts[webView]
    if (existing != null && existing.script == script) {
      return true
    }
    existing?.handler?.let { handler ->
      runCatching { handler.remove() }
    }
    return try {
      val handler = WebViewCompat.addDocumentStartJavaScript(
        webView,
        script,
        ALLOWED_DOCUMENT_START_ORIGINS
      )
      installedDocumentStartScripts[webView] =
        InstalledDocumentStartScript(script, handler)
      true
    } catch (_: Throwable) {
      false
    }
  }

  private fun removeInstalledDocumentStartScripts() {
    mainHandler.removeCallbacks(retryInstallDocumentStartRunnable)
    cachedWebViewRef = null
    for ((_, installed) in installedDocumentStartScripts) {
      runCatching { installed.handler.remove() }
    }
    installedDocumentStartScripts.clear()
  }

  private fun clearDrawerGestureExclusionObservers() {
    for ((view, listener) in observedDecorViews) {
      view.removeOnLayoutChangeListener(listener)
    }
    observedDecorViews.clear()
  }

  private fun stopKeepAliveServiceIfRunning() {
    val context = appContext.reactContext ?: appContext.currentActivity?.applicationContext ?: return
    RemoteKeepAliveService.stop(context)
  }

  private fun ensureActionNotificationChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    if (manager.getNotificationChannel(ACTION_CHANNEL_ID) != null) return

    val channel = NotificationChannel(
      ACTION_CHANNEL_ID,
      "Action Required",
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = "Alerts when an Antigravity agent requires an answer or approval."
      enableVibration(false)
      setShowBadge(true)
    }
    manager.createNotificationChannel(channel)
  }

  private fun postOrUpdateActionNotification(
    title: String,
    body: String,
    expandedBody: String,
    count: Int,
    deepLinkUrl: String,
    shouldAlert: Boolean
  ) {
    val context = appContext.reactContext ?: appContext.currentActivity?.applicationContext ?: return
    if (count <= 0) {
      cancelActionNotification()
      return
    }
    if (!deepLinkUrl.startsWith(CUSTOM_DEEP_LINK_PREFIX)) {
      return
    }
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !manager.areNotificationsEnabled()) {
      return
    }
    ensureActionNotificationChannel(context)

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, ACTION_CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
        .setPriority(Notification.PRIORITY_HIGH)
        .setDefaults(Notification.DEFAULT_SOUND or Notification.DEFAULT_LIGHTS)
    }

    val viewIntent = Intent(Intent.ACTION_VIEW, Uri.parse(deepLinkUrl)).apply {
      `package` = context.packageName
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val contentPendingIntent = PendingIntent.getActivity(
      context,
      ACTION_NOTIFICATION_ID,
      viewIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    builder
      .setSmallIcon(R.drawable.ic_stat_keep_alive)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(expandedBody.ifBlank { body }))
      .setNumber(count)
      .setAutoCancel(true)
      .setOnlyAlertOnce(!shouldAlert)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setContentIntent(contentPendingIntent)

    runCatching {
      manager.notify(ACTION_NOTIFICATION_ID, builder.build())
    }
  }

  private fun cancelActionNotification() {
    val context = appContext.reactContext ?: appContext.currentActivity?.applicationContext ?: return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    runCatching { manager.cancel(ACTION_NOTIFICATION_ID) }
  }

  override fun definition() = ModuleDefinition {
    Name("RemoteSession")

    OnCreate {
      registerActivityLifecycleObserverIfNeeded()
      runOnMain { applyDrawerGestureExclusion() }
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
        desiredDocumentStartScript = null
        removeInstalledDocumentStartScripts()
        cancelActionNotification()
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

    AsyncFunction("installDocumentStartScript") { script: String ->
      registerActivityLifecycleObserverIfNeeded()
      mainHandler.removeCallbacks(retryInstallDocumentStartRunnable)
      desiredDocumentStartScript = script
      applyDrawerGestureExclusion()
      if (!applyDocumentStartScriptIfNeeded() && script.isNotEmpty()) {
        mainHandler.postDelayed(retryInstallDocumentStartRunnable, 50L)
        mainHandler.postDelayed(retryInstallDocumentStartRunnable, 200L)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("syncActionNotification") {
      title: String,
      body: String,
      expandedBody: String,
      count: Int,
      deepLinkUrl: String,
      shouldAlert: Boolean ->
      postOrUpdateActionNotification(
        title = title,
        body = body,
        expandedBody = expandedBody,
        count = count,
        deepLinkUrl = deepLinkUrl,
        shouldAlert = shouldAlert
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearActionNotification") {
      cancelActionNotification()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("requestNotificationPermission") {
      val context = appContext.reactContext ?: appContext.currentActivity?.applicationContext
      val manager = context?.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        manager?.areNotificationsEnabled() ?: false
      } else {
        true
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground {
      stoppedForCurrentBackgroundStay = false
      runOnMain {
        registerActivityLifecycleObserverIfNeeded()
        stopKeepAliveServiceIfRunning()
        applyDrawerGestureExclusion()
        applyDocumentStartScriptIfNeeded()
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
      runOnMain {
        clearDrawerGestureExclusionObservers()
        removeInstalledDocumentStartScripts()
      }
      unregisterActivityLifecycleObserver()
      RemoteKeepAliveService.unregisterKeepAliveEndedListener(this@RemoteSessionModule)
      stopKeepAliveServiceIfRunning()
    }
  }

  companion object {
    private const val ACTION_CHANNEL_ID = "agy_remote_action_required"
    private const val ACTION_NOTIFICATION_ID = 4202
    private const val CUSTOM_DEEP_LINK_PREFIX = "antigravity-remote://"
    private val ALLOWED_DOCUMENT_START_ORIGINS = setOf(
      "https://antigravity.google.com",
      "https://antigravity.static.usercontent.goog"
    )
    private const val RELEASE_WEB_LOCK_SCRIPT =
      "(function(){try{window.__agyKeepAliveLockDesired=false;if(typeof window.__agyReleaseKeepAliveLock==='function'){window.__agyReleaseKeepAliveLock();}window.__agyKeepAliveLockHeld=false;}catch(_){}})();"
  }
}
