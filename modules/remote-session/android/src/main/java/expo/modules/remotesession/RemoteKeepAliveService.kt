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
import android.os.SystemClock

/**
 * Bounded foreground service that prevents Android's Cached Apps Freezer and Doze
 * from suspending active Antigravity Remote WebSocket sessions while multitasking.
 *
 * Strictly wall-clock bounded (1..60 minutes via elapsedRealtime) and never exported.
 */
class RemoteKeepAliveService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null
  private var deadlineElapsedRealtimeMs: Long = 0L
  private var instanceGeneration: Long = 0L

  private val keepAliveTickRunnable = object : Runnable {
    override fun run() {
      if (!desiredRunning || !isRunning || instanceGeneration != activeGeneration) {
        return
      }
      val remainingMs = deadlineElapsedRealtimeMs - SystemClock.elapsedRealtime()
      if (remainingMs <= 0L) {
        desiredRunning = false
        isRunning = false
        activeGeneration += 1L
        runCatching { notifyKeepAliveEnded(stoppedByUser = false) }
        stopKeepAliveAndSelf()
      } else {
        runCatching { notifyKeepAlivePollTick() }
        if (desiredRunning && isRunning && instanceGeneration == activeGeneration) {
          handler.postDelayed(this, minOf(remainingMs, POLL_INTERVAL_MS))
        }
      }
    }
  }

  internal fun cancelScheduledTicks() {
    handler.removeCallbacks(keepAliveTickRunnable)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP_KEEP_ALIVE) {
      val wasActive = desiredRunning || isRunning
      desiredRunning = false
      startPending = false
      isRunning = false
      activeGeneration += 1L
      if (wasActive) {
        runCatching { notifyKeepAliveEnded(stoppedByUser = true) }
      }
      stopKeepAliveAndSelf()
      return START_NOT_STICKY
    }

    startPending = false
    val requestedMinutes = intent?.getIntExtra(EXTRA_DURATION_MINUTES, DEFAULT_MINUTES)
      ?: DEFAULT_MINUTES
    val clampedMinutes = requestedMinutes.coerceIn(1, MAX_MINUTES)
    val durationMs = clampedMinutes * 60_000L

    ensureNotificationChannel()
    val notification = buildNotification(clampedMinutes, durationMs)

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
      desiredRunning = false
      isRunning = false
      activeGeneration += 1L
      runCatching { notifyKeepAliveEnded(stoppedByUser = false) }
      stopKeepAliveAndSelf()
      return START_NOT_STICKY
    }

    val intentGeneration = intent?.getLongExtra(EXTRA_GENERATION, activeGeneration) ?: activeGeneration
    if (!desiredRunning || intentGeneration != activeGeneration) {
      // Stopped while startForegroundService() was in flight: fulfill the foreground
      // contract above, then tear down cleanly without firing an expiry callback.
      stopKeepAliveAndSelf()
      return START_NOT_STICKY
    }

    instanceGeneration = activeGeneration
    activeInstance = this
    isRunning = true
    deadlineElapsedRealtimeMs = SystemClock.elapsedRealtime() + durationMs
    acquireBoundedWakeLock(durationMs)
    handler.removeCallbacks(keepAliveTickRunnable)
    handler.postDelayed(
      keepAliveTickRunnable,
      minOf(durationMs, POLL_INTERVAL_MS)
    )

    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    val shouldNotify = desiredRunning || isRunning
    desiredRunning = false
    startPending = false
    isRunning = false
    activeGeneration += 1L
    if (shouldNotify) {
      runCatching { notifyKeepAliveEnded(stoppedByUser = false) }
    }
    stopKeepAliveAndSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onTimeout(startId: Int) {
    val shouldNotify = desiredRunning || isRunning
    desiredRunning = false
    startPending = false
    isRunning = false
    activeGeneration += 1L
    if (shouldNotify) {
      runCatching { notifyKeepAliveEnded(stoppedByUser = false) }
    }
    stopKeepAliveAndSelf()
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    val shouldNotify = desiredRunning || isRunning
    desiredRunning = false
    startPending = false
    isRunning = false
    activeGeneration += 1L
    if (shouldNotify) {
      runCatching { notifyKeepAliveEnded(stoppedByUser = false) }
    }
    stopKeepAliveAndSelf()
  }

  override fun onDestroy() {
    if (activeInstance === this) {
      activeInstance = null
      isRunning = false
    }
    handler.removeCallbacks(keepAliveTickRunnable)
    releaseWakeLock()
    super.onDestroy()
  }

  private fun stopKeepAliveAndSelf() {
    if (activeInstance === this) {
      activeInstance = null
    }
    if (instanceGeneration == activeGeneration || !desiredRunning) {
      isRunning = false
    }
    handler.removeCallbacks(keepAliveTickRunnable)
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
      description = "Keeps active Antigravity Remote sessions open and checks for alerts in the background."
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(durationMinutes: Int, durationMs: Long): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID).setTimeoutAfter(durationMs)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

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
      .setSmallIcon(R.drawable.ic_stat_keep_alive)
      .setContentTitle("Antigravity Remote connected")
      .setContentText("Keeping session awake & checking for alerts (up to ${durationMinutes}m)")
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
    private const val POLL_INTERVAL_MS = 20_000L
    const val ACTION_STOP_KEEP_ALIVE = "expo.modules.remotesession.STOP_KEEP_ALIVE"
    const val EXTRA_DURATION_MINUTES = "duration_minutes"
    private const val EXTRA_GENERATION = "generation"

    @Volatile
    var isRunning: Boolean = false
      private set

    @Volatile
    private var desiredRunning: Boolean = false

    @Volatile
    private var startPending: Boolean = false

    @Volatile
    private var activeGeneration: Long = 0L

    private var activeInstance: RemoteKeepAliveService? = null

    val isActiveOrPending: Boolean
      get() = desiredRunning && (isRunning || startPending)

    private val listenerLock = Any()
    private var listenerOwner: Any? = null
    private var onKeepAliveEndedListener: ((Boolean) -> Unit)? = null
    private var pollListenerOwner: Any? = null
    private var onKeepAlivePollTickListener: (() -> Unit)? = null

    fun registerKeepAliveEndedListener(owner: Any, listener: (stoppedByUser: Boolean) -> Unit) {
      synchronized(listenerLock) {
        listenerOwner = owner
        onKeepAliveEndedListener = listener
      }
    }

    fun unregisterKeepAliveEndedListener(owner: Any) {
      synchronized(listenerLock) {
        if (listenerOwner === owner) {
          listenerOwner = null
          onKeepAliveEndedListener = null
        }
      }
    }

    fun registerKeepAlivePollListener(owner: Any, listener: () -> Unit) {
      synchronized(listenerLock) {
        pollListenerOwner = owner
        onKeepAlivePollTickListener = listener
      }
    }

    fun unregisterKeepAlivePollListener(owner: Any) {
      synchronized(listenerLock) {
        if (pollListenerOwner === owner) {
          pollListenerOwner = null
          onKeepAlivePollTickListener = null
        }
      }
    }

    private fun notifyKeepAliveEnded(stoppedByUser: Boolean) {
      val callback = synchronized(listenerLock) { onKeepAliveEndedListener }
      callback?.invoke(stoppedByUser)
    }

    private fun notifyKeepAlivePollTick() {
      val callback = synchronized(listenerLock) { onKeepAlivePollTickListener }
      callback?.invoke()
    }

    fun start(context: Context, durationMinutes: Int): Boolean {
      val clamped = durationMinutes.coerceIn(1, MAX_MINUTES)
      val nextGen = activeGeneration + 1L
      activeGeneration = nextGen
      desiredRunning = true
      startPending = true
      val intent = Intent(context, RemoteKeepAliveService::class.java).apply {
        putExtra(EXTRA_DURATION_MINUTES, clamped)
        putExtra(EXTRA_GENERATION, nextGen)
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
        desiredRunning = false
        startPending = false
        false
      }
    }

    fun stop(context: Context) {
      val hadPendingStart = startPending && !isRunning
      desiredRunning = false
      isRunning = false
      activeGeneration += 1L
      activeInstance?.cancelScheduledTicks()
      if (hadPendingStart) {
        // Avoid calling stopService() before onStartCommand() invokes startForeground(),
        // which throws RemoteServiceException on API 26-30; onStartCommand() will call
        // startForeground() and immediately tear down upon seeing !desiredRunning.
        return
      }
      startPending = false
      try {
        context.stopService(Intent(context, RemoteKeepAliveService::class.java))
      } catch (_: Exception) {
        // Ignore if service was never started
      }
    }
  }
}
