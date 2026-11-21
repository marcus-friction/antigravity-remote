package expo.modules.remotesession

import android.app.Activity
import android.app.Application
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.View
import android.view.ViewGroup
import android.widget.RemoteViews
import java.lang.ref.WeakReference
import java.util.WeakHashMap
import org.json.JSONArray
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

  private data class ActionCardItem(
    val title: String,
    val attentionKind: String,
    val statusLabel: String,
    val attentionReason: String,
    val projectName: String,
    val instanceName: String,
    val subtitle: String,
    val deepLinkUrl: String
  )

  private data class ActionCardStyle(
    val cardBgRes: Int,
    val accentRes: Int,
    val badgeBgRes: Int,
    val badgeTextColor: Int,
    val reasonTextColor: Int,
    val headerAccentColor: Int
  )

  private val mainHandler = Handler(Looper.getMainLooper())
  @Volatile private var keepAliveEnabled: Boolean = false
  @Volatile private var keepAliveMinutes: Int = 0
  @Volatile private var sessionActive: Boolean = false
  @Volatile private var stoppedForCurrentBackgroundStay: Boolean = false
  @Volatile private var serviceStartRequested: Boolean = false
  @Volatile private var isActivityStarted: Boolean = false
  @Volatile private var isActivityResumed: Boolean = false
  @Volatile private var desiredDocumentStartScript: String? = null
  private var registeredApplication: Application? = null
  private var screenStateReceiverContext: Context? = null
  private var lastActivityRef: WeakReference<Activity>? = null
  private var cachedWebViewRef: WeakReference<WebView>? = null
  private val observedDecorViews = WeakHashMap<View, View.OnLayoutChangeListener>()
  private val installedDocumentStartScripts =
    WeakHashMap<WebView, InstalledDocumentStartScript>()
  private val retryInstallDocumentStartRunnable = Runnable {
    applyDocumentStartScriptIfNeeded()
  }

  private val screenStateReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      when (intent?.action) {
        Intent.ACTION_SCREEN_OFF -> {
          runOnMain {
            if (
              shouldKeepAlive() &&
              !stoppedForCurrentBackgroundStay &&
              (isActivityStarted || serviceStartRequested || RemoteKeepAliveService.isRunning)
            ) {
              startBackgroundKeepAliveIfEligible()
            }
          }
        }
        Intent.ACTION_USER_PRESENT -> {
          runOnMain {
            if (isActivityResumed) {
              handleReturnedToInteractiveForeground()
            }
          }
        }
      }
    }
  }

  private val activityLifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityStarted(activity: Activity) {
      val current = appContext.currentActivity
      if (current != null && activity !== current) return
      lastActivityRef = WeakReference(activity)
      isActivityStarted = true
      runOnMain {
        handleReturnedToInteractiveForeground(activity)
      }
    }

    override fun onActivityResumed(activity: Activity) {
      val current = appContext.currentActivity
      if (current != null && activity !== current) return
      lastActivityRef = WeakReference(activity)
      isActivityStarted = true
      isActivityResumed = true
      runOnMain {
        handleReturnedToInteractiveForeground(activity)
      }
    }

    override fun onActivityPaused(activity: Activity) {
      val current = appContext.currentActivity
      if (current != null && activity !== current) return
      isActivityResumed = false
    }

    override fun onActivityStopped(activity: Activity) {
      // Ignore configuration changes (e.g. screen rotation) and unrelated activities;
      // unlike Activity.onPause, onStop only runs when the window is no longer visible
      // (avoiding permission-dialog and split-screen focus churn).
      if (activity.isChangingConfigurations) return
      val current = appContext.currentActivity
      if (current != null && activity !== current) return
      lastActivityRef = WeakReference(activity)
      isActivityStarted = false
      isActivityResumed = false
      runOnMain {
        startBackgroundKeepAliveIfEligible(hostActivity = activity)
      }
    }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) {
      if (lastActivityRef?.get() === activity) {
        lastActivityRef = null
      }
      val decorView = activity.window?.decorView
      val contentView = activity.findViewById<View>(android.R.id.content)
      runOnMain {
        if (decorView != null) {
          observedDecorViews.remove(decorView)?.let { listener ->
            decorView.removeOnLayoutChangeListener(listener)
          }
        }
        if (contentView != null && contentView !== decorView) {
          observedDecorViews.remove(contentView)?.let { listener ->
            contentView.removeOnLayoutChangeListener(listener)
          }
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

  private fun isInteractiveAndUnlocked(context: Context?): Boolean {
    val ctx = context ?: appContext.reactContext ?: appContext.currentActivity?.applicationContext ?: return true
    val powerManager = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
    val isInteractive = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) {
      powerManager?.isInteractive ?: true
    } else {
      @Suppress("DEPRECATION")
      powerManager?.isScreenOn ?: true
    }
    if (!isInteractive) {
      return false
    }
    val keyguardManager = ctx.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
    return keyguardManager?.isKeyguardLocked != true
  }

  private fun isTrustedAntigravityUrl(rawUrl: String?): Boolean {
    if (rawUrl.isNullOrBlank()) return false
    return runCatching {
      val uri = Uri.parse(rawUrl)
      uri.scheme.equals("https", ignoreCase = true) &&
        uri.host.equals("antigravity.google.com", ignoreCase = true) &&
        uri.port == -1 &&
        uri.userInfo == null
    }.getOrDefault(false)
  }

  private fun registerScreenStateReceiverIfNeeded() {
    if (screenStateReceiverContext != null) return
    val ctx = (appContext.reactContext?.applicationContext ?: appContext.currentActivity?.applicationContext)
      ?: return
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_OFF)
      addAction(Intent.ACTION_USER_PRESENT)
    }
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ctx.registerReceiver(screenStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        ctx.registerReceiver(screenStateReceiver, filter)
      }
      screenStateReceiverContext = ctx
    }
  }

  private fun unregisterScreenStateReceiver() {
    val ctx = screenStateReceiverContext ?: return
    screenStateReceiverContext = null
    runCatching {
      ctx.unregisterReceiver(screenStateReceiver)
    }
  }

  private fun registerActivityLifecycleObserverIfNeeded() {
    registerScreenStateReceiverIfNeeded()
    val current = appContext.currentActivity
    if (current != null && !current.isFinishing) {
      lastActivityRef = WeakReference(current)
      if (!isActivityStarted && isInteractiveAndUnlocked(current)) {
        isActivityStarted = true
      }
    }
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

  private fun resolveActiveWebView(hostActivity: Activity? = null): WebView? {
    val cached = cachedWebViewRef?.get()
    if (cached != null && cached.isAttachedToWindow && cached.parent != null) {
      return cached
    }
    val activity = hostActivity ?: appContext.currentActivity ?: lastActivityRef?.get() ?: return null
    return resolveWebView(activity.window?.decorView)
  }

  private fun shouldKeepAlive(): Boolean {
    return keepAliveEnabled && keepAliveMinutes > 0 && sessionActive
  }

  private fun handleReturnedToInteractiveForeground(hostActivity: Activity? = null) {
    val activity = hostActivity ?: appContext.currentActivity ?: lastActivityRef?.get()
    if (!isInteractiveAndUnlocked(activity ?: appContext.reactContext)) {
      return
    }
    stoppedForCurrentBackgroundStay = false
    serviceStartRequested = false
    stopKeepAliveServiceIfRunning()
    if (activity != null) {
      applyDrawerGestureExclusion(activity)
      applyDocumentStartScriptIfNeeded(activity)
    } else {
      applyDrawerGestureExclusion()
      applyDocumentStartScriptIfNeeded()
    }
    applyWebViewKeepAlivePolicy(
      protectInBackground = shouldKeepAlive(),
      wakeTimers = true,
      hostActivity = activity
    )
  }

  private fun startBackgroundKeepAliveIfEligible(hostActivity: Activity? = null) {
    if (!shouldKeepAlive() || stoppedForCurrentBackgroundStay) {
      applyWebViewKeepAlivePolicy(
        protectInBackground = false,
        releaseWebLock = true,
        hostActivity = hostActivity
      )
      stopKeepAliveServiceIfRunning()
      return
    }
    applyWebViewKeepAlivePolicy(
      protectInBackground = true,
      wakeTimers = true,
      hostActivity = hostActivity
    )
    if (serviceStartRequested || RemoteKeepAliveService.isRunning) {
      return
    }
    val context = appContext.reactContext
      ?: hostActivity?.applicationContext
      ?: appContext.currentActivity?.applicationContext
      ?: lastActivityRef?.get()?.applicationContext
      ?: return
    serviceStartRequested = true
    if (!RemoteKeepAliveService.start(context, keepAliveMinutes)) {
      serviceStartRequested = false
      applyWebViewKeepAlivePolicy(
        protectInBackground = false,
        releaseWebLock = true,
        hostActivity = hostActivity
      )
    }
  }

  private fun triggerBackgroundStateRefresh() {
    if (!shouldKeepAlive() || stoppedForCurrentBackgroundStay) {
      return
    }
    val webView = resolveActiveWebView() ?: return
    if (!isTrustedAntigravityUrl(webView.url)) {
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.setRendererPriorityPolicy(
        WebView.RENDERER_PRIORITY_IMPORTANT,
        /* waivedWhenNotVisible = */ false
      )
    }
    webView.resumeTimers()
    webView.evaluateJavascript(BACKGROUND_POLL_SCRIPT, null)
  }

  private fun applyWebViewKeepAlivePolicy(
    protectInBackground: Boolean,
    wakeTimers: Boolean = false,
    releaseWebLock: Boolean = false,
    hostActivity: Activity? = null
  ) {
    val webView = resolveActiveWebView(hostActivity) ?: return
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
    val contentView = activity.findViewById<View>(android.R.id.content)

    fun updateExclusionRects(targetDecorView: View) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
      val fullHeight = targetDecorView.height
      if (fullHeight <= 0) return
      val visibleFrame = Rect()
      targetDecorView.getWindowVisibleDisplayFrame(visibleFrame)
      val visibleTop = visibleFrame.top.coerceIn(0, fullHeight)
      val visibleBottom = if (visibleFrame.bottom > visibleTop) {
        visibleFrame.bottom.coerceAtMost(fullHeight)
      } else {
        fullHeight
      }
      val visibleHeight = (visibleBottom - visibleTop).coerceAtLeast(1)
      val density = targetDecorView.resources.displayMetrics.density
      // Android caps total exclusion height per edge to 200dp; keep centered in the
      // visible viewport so the handle remains excluded even while the IME is open.
      val halfZonePx = minOf((100f * density).toInt(), visibleHeight / 2)
      val edgeWidthPx = (64f * density).toInt()
      val centerY = visibleTop + visibleHeight / 2
      targetDecorView.systemGestureExclusionRects = listOf(
        Rect(
          0,
          (centerY - halfZonePx).coerceAtLeast(visibleTop),
          edgeWidthPx,
          (centerY + halfZonePx).coerceAtMost(visibleBottom)
        )
      )
    }

    if (!observedDecorViews.containsKey(decorView)) {
      val listener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        updateExclusionRects(decorView)
        applyDocumentStartScriptIfNeeded(activity)
      }
      observedDecorViews[decorView] = listener
      decorView.addOnLayoutChangeListener(listener)
    }
    if (contentView != null && contentView !== decorView && !observedDecorViews.containsKey(contentView)) {
      val contentListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        updateExclusionRects(decorView)
      }
      observedDecorViews[contentView] = contentListener
      contentView.addOnLayoutChangeListener(contentListener)
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
    serviceStartRequested = false
    val context = appContext.reactContext
      ?: appContext.currentActivity?.applicationContext
      ?: lastActivityRef?.get()?.applicationContext
      ?: return
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

  private fun parseActionCardItems(itemsJson: String): List<ActionCardItem> {
    if (itemsJson.isBlank()) return emptyList()
    return runCatching {
      val array = JSONArray(itemsJson)
      val result = ArrayList<ActionCardItem>(minOf(array.length(), MAX_PARSED_NOTIFICATION_CARDS))
      for (i in 0 until minOf(array.length(), MAX_PARSED_NOTIFICATION_CARDS)) {
        val obj = array.optJSONObject(i) ?: continue
        val title = obj.optString("title", "").trim()
        if (title.isEmpty()) continue
        val kind = obj.optString("attentionKind", "unread").trim().lowercase()
        val statusLabel = obj.optString("statusLabel", "").trim().ifEmpty {
          when (kind) {
            "approval" -> "NEEDS APPROVAL"
            "error" -> "NEEDS REVIEW"
            "unread" -> "FINISHED"
            "running" -> "WORKING"
            else -> "UPDATE"
          }
        }
        val reason = obj.optString("attentionReason", "").trim()
        val projectName = if (obj.isNull("projectName")) "" else obj.optString("projectName", "").trim()
        val instanceName = if (obj.isNull("instanceName")) "" else obj.optString("instanceName", "").trim()
        val subtitle = obj.optString("subtitle", "").trim()
        val link = obj.optString("deepLinkUrl", "").trim()
        result.add(
          ActionCardItem(
            title = title,
            attentionKind = kind,
            statusLabel = statusLabel,
            attentionReason = reason,
            projectName = projectName,
            instanceName = instanceName,
            subtitle = subtitle,
            deepLinkUrl = link
          )
        )
      }
      result
    }.getOrDefault(emptyList())
  }

  private fun resolveActionCardStyle(kind: String): ActionCardStyle {
    return when (kind) {
      "approval" -> ActionCardStyle(
        cardBgRes = R.drawable.notif_card_bg_approval,
        accentRes = R.drawable.notif_accent_approval,
        badgeBgRes = R.drawable.notif_badge_approval,
        badgeTextColor = Color.parseColor("#FDE68A"),
        reasonTextColor = Color.parseColor("#FDE68A"),
        headerAccentColor = Color.parseColor("#F59E0B")
      )
      "error" -> ActionCardStyle(
        cardBgRes = R.drawable.notif_card_bg_error,
        accentRes = R.drawable.notif_accent_error,
        badgeBgRes = R.drawable.notif_badge_error,
        badgeTextColor = Color.parseColor("#FECACA"),
        reasonTextColor = Color.parseColor("#FCA5A5"),
        headerAccentColor = Color.parseColor("#EF4444")
      )
      "unread" -> ActionCardStyle(
        cardBgRes = R.drawable.notif_card_bg_unread,
        accentRes = R.drawable.notif_accent_unread,
        badgeBgRes = R.drawable.notif_badge_unread,
        badgeTextColor = Color.parseColor("#BFDBFE"),
        reasonTextColor = Color.parseColor("#93C5FD"),
        headerAccentColor = Color.parseColor("#3279F9")
      )
      else -> ActionCardStyle(
        cardBgRes = R.drawable.notif_card_bg_default,
        accentRes = R.drawable.notif_accent_default,
        badgeBgRes = R.drawable.notif_badge_default,
        badgeTextColor = Color.parseColor("#BCBDC6"),
        reasonTextColor = Color.parseColor("#BCBDC6"),
        headerAccentColor = Color.parseColor("#3279F9")
      )
    }
  }

  private fun createDeepLinkPendingIntent(
    context: Context,
    requestCode: Int,
    targetDeepLink: String,
    fallbackDeepLink: String
  ): PendingIntent {
    val safeLink = if (targetDeepLink.startsWith(CUSTOM_DEEP_LINK_PREFIX)) {
      targetDeepLink
    } else {
      fallbackDeepLink
    }
    val viewIntent = Intent(Intent.ACTION_VIEW, Uri.parse(safeLink)).apply {
      `package` = context.packageName
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    return PendingIntent.getActivity(
      context,
      requestCode,
      viewIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun buildCollapsedCardRemoteViews(
    context: Context,
    primaryItem: ActionCardItem,
    totalCount: Int,
    hasUrgent: Boolean
  ): RemoteViews {
    val style = resolveActionCardStyle(primaryItem.attentionKind)
    return RemoteViews(context.packageName, R.layout.notification_action_collapsed).apply {
      setInt(R.id.notif_collapsed_card, "setBackgroundResource", style.cardBgRes)
      setImageViewResource(R.id.notif_collapsed_accent, style.accentRes)
      setInt(R.id.notif_collapsed_badge, "setBackgroundResource", style.badgeBgRes)
      setTextViewText(R.id.notif_collapsed_badge, primaryItem.statusLabel)
      setTextColor(R.id.notif_collapsed_badge, style.badgeTextColor)
      setTextViewText(R.id.notif_collapsed_title, primaryItem.title)
      if (primaryItem.projectName.isNotEmpty()) {
        setTextViewText(R.id.notif_collapsed_project, primaryItem.projectName)
        setViewVisibility(R.id.notif_collapsed_project_row, View.VISIBLE)
      } else {
        setViewVisibility(R.id.notif_collapsed_project_row, View.GONE)
      }
      if (primaryItem.attentionReason.isNotEmpty()) {
        setTextViewText(R.id.notif_collapsed_reason, primaryItem.attentionReason)
        setTextColor(R.id.notif_collapsed_reason, style.reasonTextColor)
        setViewVisibility(R.id.notif_collapsed_reason, View.VISIBLE)
      } else {
        setViewVisibility(R.id.notif_collapsed_reason, View.GONE)
      }
      val fallbackMeta = primaryItem.instanceName.ifEmpty { primaryItem.subtitle }
      if (primaryItem.projectName.isEmpty() && fallbackMeta.isNotEmpty()) {
        setTextViewText(R.id.notif_collapsed_subtitle, fallbackMeta)
        setViewVisibility(R.id.notif_collapsed_subtitle, View.VISIBLE)
      } else {
        setViewVisibility(R.id.notif_collapsed_subtitle, View.GONE)
      }
      if (totalCount > 1) {
        val extraCount = totalCount - 1
        setTextViewText(R.id.notif_collapsed_count_pill, "+$extraCount")
        setInt(
          R.id.notif_collapsed_count_pill,
          "setBackgroundResource",
          if (hasUrgent) R.drawable.notif_count_pill_urgent else R.drawable.notif_count_pill_unread
        )
        setViewVisibility(R.id.notif_collapsed_count_pill, View.VISIBLE)
      } else {
        setViewVisibility(R.id.notif_collapsed_count_pill, View.GONE)
      }
    }
  }

  private fun buildExpandedCardsRemoteViews(
    context: Context,
    items: List<ActionCardItem>,
    totalCount: Int,
    fallbackDeepLink: String
  ): RemoteViews {
    val container = RemoteViews(context.packageName, R.layout.notification_action_expanded)
    container.removeAllViews(R.id.notif_cards_container)

    val hasProjectRows = items
      .take(MAX_RENDERED_NOTIFICATION_CARDS)
      .any { it.projectName.isNotEmpty() }
    val maxCards = if (hasProjectRows && totalCount > MAX_RENDERED_NOTIFICATION_CARDS) {
      MAX_RENDERED_NOTIFICATION_CARDS_WITH_OVERFLOW
    } else {
      MAX_RENDERED_NOTIFICATION_CARDS
    }
    val renderedItems = items.take(maxCards)
    renderedItems.forEachIndexed { index, item ->
      val style = resolveActionCardStyle(item.attentionKind)
      val cardView = RemoteViews(context.packageName, R.layout.notification_action_card_item).apply {
        setInt(R.id.notif_card_root, "setBackgroundResource", style.cardBgRes)
        setImageViewResource(R.id.notif_card_accent, style.accentRes)
        setInt(R.id.notif_card_badge, "setBackgroundResource", style.badgeBgRes)
        setTextViewText(R.id.notif_card_badge, item.statusLabel)
        setTextColor(R.id.notif_card_badge, style.badgeTextColor)
        if (item.projectName.isNotEmpty()) {
          setTextViewText(R.id.notif_card_project, item.projectName)
          setViewVisibility(R.id.notif_card_project_row, View.VISIBLE)
        } else {
          setViewVisibility(R.id.notif_card_project_row, View.GONE)
        }
        setTextViewText(R.id.notif_card_title, item.title)
        if (item.attentionReason.isNotEmpty()) {
          setTextViewText(R.id.notif_card_reason, item.attentionReason)
          setTextColor(R.id.notif_card_reason, style.reasonTextColor)
          setViewVisibility(R.id.notif_card_reason, View.VISIBLE)
        } else {
          setViewVisibility(R.id.notif_card_reason, View.GONE)
        }
        val rightMeta = if (item.projectName.isNotEmpty()) {
          item.instanceName
        } else {
          item.subtitle
        }
        if (rightMeta.isNotEmpty()) {
          setTextViewText(R.id.notif_card_subtitle, rightMeta)
          setViewVisibility(R.id.notif_card_subtitle, View.VISIBLE)
        } else {
          setViewVisibility(R.id.notif_card_subtitle, View.GONE)
        }
        if (index == renderedItems.lastIndex) {
          setViewPadding(R.id.notif_card_wrapper, 0, 0, 0, 0)
        }
        // For multi-action notifications, wire each card directly to its thread deep link;
        // single-action notifications use the builder's main contentIntent so autoCancel fires immediately.
        if (totalCount > 1) {
          val cardPendingIntent = createDeepLinkPendingIntent(
            context = context,
            requestCode = ACTION_NOTIFICATION_CARD_BASE_ID + index,
            targetDeepLink = item.deepLinkUrl,
            fallbackDeepLink = fallbackDeepLink
          )
          setOnClickPendingIntent(R.id.notif_card_root, cardPendingIntent)
        }
      }
      container.addView(R.id.notif_cards_container, cardView)
    }

    val remaining = totalCount - renderedItems.size
    if (remaining > 0) {
      container.setTextViewText(
        R.id.notif_overflow_text,
        "+$remaining more in Inbox • Tap to open"
      )
      container.setViewVisibility(R.id.notif_overflow_text, View.VISIBLE)
    } else {
      container.setViewVisibility(R.id.notif_overflow_text, View.GONE)
    }

    return container
  }

  private fun postOrUpdateActionNotification(
    title: String,
    body: String,
    expandedBody: String,
    count: Int,
    deepLinkUrl: String,
    shouldAlert: Boolean,
    itemsJson: String
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

    val contentPendingIntent = createDeepLinkPendingIntent(
      context = context,
      requestCode = ACTION_NOTIFICATION_ID,
      targetDeepLink = deepLinkUrl,
      fallbackDeepLink = deepLinkUrl
    )

    val cards = parseActionCardItems(itemsJson)
    val hasUrgent = cards.any { it.attentionKind == "approval" || it.attentionKind == "error" }
    val primaryStyle = cards.firstOrNull()?.let { resolveActionCardStyle(it.attentionKind) }

    builder
      .setSmallIcon(R.drawable.ic_stat_keep_alive)
      .setContentTitle(title)
      .setContentText(body)
      .setNumber(count)
      .setWhen(System.currentTimeMillis())
      .setShowWhen(true)
      .setAutoCancel(true)
      .setOnlyAlertOnce(!shouldAlert)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setContentIntent(contentPendingIntent)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      val accentColor = primaryStyle?.headerAccentColor ?: Color.parseColor("#3279F9")
      builder.setColor(accentColor)
      // Non-sensitive lock-screen summary shown when the user hides sensitive
      // notification details on a locked screen (never includes titles/hosts/commands).
      val publicBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, ACTION_CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
      val publicSummary = if (count == 1) {
        "1 action requires your attention"
      } else {
        "$count actions require your attention"
      }
      publicBuilder
        .setSmallIcon(R.drawable.ic_stat_keep_alive)
        .setContentTitle("Antigravity Remote")
        .setContentText(publicSummary)
        .setNumber(count)
        .setColor(accentColor)
        .setCategory(Notification.CATEGORY_MESSAGE)
      builder.setPublicVersion(publicBuilder.build())
    }

    val appliedCustomCards = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && cards.isNotEmpty()) {
      runCatching {
        val collapsedViews = buildCollapsedCardRemoteViews(
          context = context,
          primaryItem = cards.first(),
          totalCount = count,
          hasUrgent = hasUrgent
        )
        val expandedViews = buildExpandedCardsRemoteViews(
          context = context,
          items = cards,
          totalCount = count,
          fallbackDeepLink = deepLinkUrl
        )
        builder
          .setStyle(Notification.DecoratedCustomViewStyle())
          .setCustomContentView(collapsedViews)
          .setCustomBigContentView(expandedViews)
        true
      }.getOrDefault(false)
    } else {
      false
    }

    if (!appliedCustomCards) {
      builder.setStyle(Notification.BigTextStyle().bigText(expandedBody.ifBlank { body }))
    }

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
      RemoteKeepAliveService.registerKeepAliveEndedListener(this@RemoteSessionModule) { _ ->
        stoppedForCurrentBackgroundStay = true
        serviceStartRequested = false
        runOnMain {
          applyWebViewKeepAlivePolicy(
            protectInBackground = false,
            releaseWebLock = true
          )
        }
      }
      RemoteKeepAliveService.registerKeepAlivePollListener(this@RemoteSessionModule) {
        runOnMain {
          triggerBackgroundStateRefresh()
        }
      }
    }

    AsyncFunction("clearWebData") { promise: Promise ->
      try {
        sessionActive = false
        stoppedForCurrentBackgroundStay = false
        serviceStartRequested = false
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
      shouldAlert: Boolean,
      itemsJson: String ->
      postOrUpdateActionNotification(
        title = title,
        body = body,
        expandedBody = expandedBody,
        count = count,
        deepLinkUrl = deepLinkUrl,
        shouldAlert = shouldAlert,
        itemsJson = itemsJson
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
      runOnMain {
        registerActivityLifecycleObserverIfNeeded()
        handleReturnedToInteractiveForeground()
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
      unregisterScreenStateReceiver()
      unregisterActivityLifecycleObserver()
      RemoteKeepAliveService.unregisterKeepAlivePollListener(this@RemoteSessionModule)
      RemoteKeepAliveService.unregisterKeepAliveEndedListener(this@RemoteSessionModule)
      stopKeepAliveServiceIfRunning()
    }
  }

  companion object {
    private const val ACTION_CHANNEL_ID = "agy_remote_action_required"
    private const val ACTION_NOTIFICATION_ID = 4202
    private const val ACTION_NOTIFICATION_CARD_BASE_ID = 4210
    private const val MAX_PARSED_NOTIFICATION_CARDS = 4
    private const val MAX_RENDERED_NOTIFICATION_CARDS = 3
    private const val MAX_RENDERED_NOTIFICATION_CARDS_WITH_OVERFLOW = 2
    private const val CUSTOM_DEEP_LINK_PREFIX = "antigravity-remote://"
    private val ALLOWED_DOCUMENT_START_ORIGINS = setOf(
      "https://antigravity.google.com",
      "https://antigravity.static.usercontent.goog"
    )
    private const val RELEASE_WEB_LOCK_SCRIPT =
      "(function(){try{window.__agyKeepAliveLockDesired=false;if(typeof window.__agyReleaseKeepAliveLock==='function'){window.__agyReleaseKeepAliveLock();}window.__agyKeepAliveLockHeld=false;}catch(_){}})();"
    private const val BACKGROUND_POLL_SCRIPT =
      "(function(){try{if(!window.location||window.location.hostname!=='antigravity.google.com')return;window.__agyKeepAliveLockDesired=true;if(!window.__agyKeepAliveLockHeld&&!window.__agyKeepAliveLockPending&&navigator&&navigator.locks&&typeof navigator.locks.request==='function'){window.__agyKeepAliveLockPending=true;navigator.locks.request('__agy_remote_keep_alive',function(){window.__agyKeepAliveLockPending=false;if(!window.__agyKeepAliveLockDesired){window.__agyKeepAliveLockHeld=false;return Promise.resolve();}window.__agyKeepAliveLockHeld=true;return new Promise(function(resolve){window.__agyReleaseKeepAliveLock=function(){window.__agyKeepAliveLockHeld=false;window.__agyReleaseKeepAliveLock=null;resolve();};if(!window.__agyKeepAliveLockDesired){window.__agyReleaseKeepAliveLock();}});}).catch(function(){window.__agyKeepAliveLockPending=false;window.__agyKeepAliveLockHeld=false;});}if(window.__agyInboxBridge&&typeof window.__agyInboxBridge.backgroundTick==='function'){window.__agyInboxBridge.backgroundTick();}else if(window.__agyInboxBridge&&typeof window.__agyInboxBridge.refresh==='function'){window.__agyInboxBridge.refresh(false,true);}}catch(_){}})();"
  }
}
