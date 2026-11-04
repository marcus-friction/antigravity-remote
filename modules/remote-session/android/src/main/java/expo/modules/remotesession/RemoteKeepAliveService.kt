package expo.modules.remotesession

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager

/**
 * Bounded foreground service that prevents Android's Cached Apps Freezer and Doze
 * from suspending active Antigravity Remote WebSocket sessions while multitasking.
 *
 * Strictly time-bounded (1..60 minutes) and never exported to other apps.
 */
class RemoteKeepAliveService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null
  private val autoStopRunnable = Runnable {
    stopKeepAliveAndSelf()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP_KEEP_ALIVE) {
      onUserStoppedCallback?.invoke()
      stopKeepAliveAndSelf()
      return START_NOT_STICKY
    }

    val requestedMinutes = intent?.getIntExtra(EXTRA_DURATION_MINUTES, DEFAULT_MINUTES)
      ?: DEFAULT_MINUTES
    val clampedMinutes = requestedMinutes.coerceIn(1, MAX_MINUTES)
    val durationMs = clampedMinutes * 60_000L

    ensureNotificationChannel()
    val notification = buildNotification(clampedMinutes)

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (_: Exception) {
      stopKeepAliveAndSelf()
      return START_NOT_STICKY
    }

    acquireBoundedWakeLock(durationMs)
    handler.removeCallbacks(autoStopRunnable)
    handler.postDelayed(autoStopRunnable, durationMs)

    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    stopKeepAliveAndSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onTimeout(startId: Int) {
    stopKeepAliveAndSelf()
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    stopKeepAliveAndSelf()
  }

  override fun onDestroy() {
    handler.removeCallbacks(autoStopRunnable)
    releaseWakeLock()
    super.onDestroy()
  }

  private fun stopKeepAliveAndSelf() {
    handler.removeCallbacks(autoStopRunnable)
    releaseWakeLock()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
    } catch (_: Exception) {
      // Ignore if not currently in foreground state
    }
    stopSelf()
  }

  private fun acquireBoundedWakeLock(durationMs: Long) {
    releaseWakeLock()
    try {
      val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
      wakeLock = powerManager.newWakeLock(
        PowerManager.PARTIAL_WAKE_LOCK,
        "AntigravityRemote:SessionKeepAlive"
      ).apply {
        setReferenceCounted(false)
        acquire(durationMs)
      }
    } catch (_: Exception) {
      wakeLock = null
    }
  }

  private fun releaseWakeLock() {
    try {
      wakeLock?.let {
        if (it.isHeld) {
          it.release()
        }
      }
    } catch (_: Exception) {
      // Ignore already-released wake lock
    }
    wakeLock = null
  }

  private fun ensureNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return

    val channel = NotificationChannel(
      CHANNEL_ID,
      "Background Session Keep-Alive",
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "Keeps active Antigravity Remote connections open while multitasking."
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(durationMinutes: Int): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    val smallIcon = applicationInfo.icon.takeIf { it != 0 }
      ?: android.R.drawable.stat_notify_sync

    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val contentPendingIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }

    val stopIntent = Intent(this, RemoteKeepAliveService::class.java).apply {
      action = ACTION_STOP_KEEP_ALIVE
    }
    val stopPendingIntent = PendingIntent.getService(
      this,
      1,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val stopAction = Notification.Action.Builder(
      null,
      "Stop Keep-Alive",
      stopPendingIntent
    ).build()

    builder
      .setSmallIcon(smallIcon)
      .setContentTitle("Antigravity Remote connected")
      .setContentText("Keeping session open in background (up to ${durationMinutes}m)")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .addAction(stopAction)

    if (contentPendingIntent != null) {
      builder.setContentIntent(contentPendingIntent)
    }

    return builder.build()
  }

  companion object {
    private const val CHANNEL_ID = "agy_remote_keep_alive"
    private const val NOTIFICATION_ID = 4201
    private const val DEFAULT_MINUTES = 30
    private const val MAX_MINUTES = 60
    const val ACTION_STOP_KEEP_ALIVE = "expo.modules.remotesession.STOP_KEEP_ALIVE"
    const val EXTRA_DURATION_MINUTES = "duration_minutes"

    @Volatile
    var onUserStoppedCallback: (() -> Unit)? = null

    fun start(context: Context, durationMinutes: Int): Boolean {
      val clamped = durationMinutes.coerceIn(1, MAX_MINUTES)
      val intent = Intent(context, RemoteKeepAliveService::class.java).apply {
        putExtra(EXTRA_DURATION_MINUTES, clamped)
      }
      return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        true
      } catch (_: Exception) {
        // ForegroundServiceStartNotAllowedException or OEM restriction
        false
      }
    }

    fun stop(context: Context) {
      try {
        context.stopService(Intent(context, RemoteKeepAliveService::class.java))
      } catch (_: Exception) {
        // Ignore if service was never started
      }
    }
  }
}
