package com.hackerx.wormgpt_agent.callguard

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.hackerx.wormgpt_agent.MainActivity

/**
 * 🛡️ Anti-Background-Kill foreground service.
 *
 * A persistent FOREGROUND service is the ONLY supported way on modern Android
 * to stop the OS / OEM battery managers from silently killing the Phone Guard.
 * While this runs:
 *   • Android keeps the app process alive (foreground priority).
 *   • The NotificationListener (WhatsApp Guard) and SharedPreferences-backed
 *     CallScreening rules stay warm and responsive.
 *   • A low-priority "Phone Guard is protecting you" notification is shown
 *     (required by Android 8+; it is the user's manual off-switch — they stop
 *     the guard from the Phone Guard screen, never the OS).
 *
 * START_STICKY + onTaskRemoved re-start make it self-heal if the system ever
 * does reclaim it under extreme memory pressure.
 */
class GuardForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "wormgpt_phone_guard"
        const val NOTIF_ID = 4711
        const val ACTION_START = "com.hackerx.wormgpt_agent.GUARD_START"
        const val ACTION_STOP = "com.hackerx.wormgpt_agent.GUARD_STOP"

        fun start(ctx: Context) {
            val i = Intent(ctx, GuardForegroundService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, GuardForegroundService::class.java).setAction(ACTION_STOP))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            CallGuardStore.setBool(this, "guard_persistent", false)
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        CallGuardStore.setBool(this, "guard_persistent", true)
        startForeground(NOTIF_ID, buildNotification())
        // START_STICKY → the OS will try to recreate us with a null intent if
        // it ever kills the service, so the guard comes back automatically.
        return START_STICKY
    }

    /** If the user swipes the app away, re-arm the service so the guard persists. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (CallGuardStore.getBool(this, "guard_persistent")) {
            try { start(this) } catch (_: Throwable) {}
        }
    }

    private fun buildNotification(): Notification {
        ensureChannel()
        val tap = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            else PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("🛡️ Phone Guard is active")
            .setContentText("Screening calls & WhatsApp. Tap to manage.")
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setShowWhen(false)
            .setContentIntent(tap)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val ch = NotificationChannel(
                    CHANNEL_ID,
                    "Phone Guard protection",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Keeps call & WhatsApp screening running in the background."
                    setShowBadge(false)
                }
                nm.createNotificationChannel(ch)
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            stopForeground(true)
        }
    }
}
