package com.hackerx.wormgpt_agent.callguard

import android.app.Notification
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * 💬 WhatsApp Guard — notification-listener powered call / audio blocker.
 *
 * Android does NOT expose WhatsApp calls to a CallScreeningService (those only
 * cover the carrier/cellular line). What WhatsApp DOES post for every incoming
 * call, voice-note and message is a NOTIFICATION. With Notification-Access
 * granted, this service sees EVERY one of them before/while it shows, reads the
 * caller/sender name, and — if it matches the user's WhatsApp block rules —
 * instantly CANCELS the notification so the call/ring is dismissed.
 *
 * Honesty note: a notification listener cannot forcibly "hang up" WhatsApp's
 * internal call UI on every OEM, but cancelling the high-priority call
 * notification removes the ring/heads-up and the call is dropped on most
 * devices. We log every decision so the user can see exactly what happened.
 *
 * Covered packages:
 *   com.whatsapp           — WhatsApp
 *   com.whatsapp.w4b       — WhatsApp Business
 */
class WhatsAppGuardService : NotificationListenerService() {

    companion object {
        private val WA_PACKAGES = setOf("com.whatsapp", "com.whatsapp.w4b")

        // Heuristics for classifying a WhatsApp notification.
        private val CALL_HINTS = listOf(
            "incoming voice call", "incoming video call", "voice call", "video call",
            "is calling", "calling you", "ongoing call", "incoming call", "missed call"
        )
        private val AUDIO_HINTS = listOf(
            "voice message", "audio", "🎤", "🎙"
        )
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            val pkg = sbn.packageName ?: return
            if (pkg !in WA_PACKAGES) return
            if (!CallGuardStore.getBool(this, "wa_enabled")) return

            val n: Notification = sbn.notification ?: return
            val extras = n.extras ?: return

            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            val sub = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString().orEmpty()
            val big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
            val ticker = n.tickerText?.toString().orEmpty()

            val haystack = listOf(title, text, sub, big, ticker)
                .joinToString(" ").lowercase()

            val category = n.category // e.g. Notification.CATEGORY_CALL on call notifs

            val kind = when {
                category == Notification.CATEGORY_CALL ||
                    CALL_HINTS.any { haystack.contains(it) } -> "call"
                AUDIO_HINTS.any { haystack.contains(it) } -> "audio"
                else -> return // a normal text message — never touched.
            }

            // The contact name is almost always the notification TITLE (WhatsApp
            // puts the caller / sender there). Fall back to the text otherwise.
            val contactName = title.ifBlank { text }

            val block = CallGuardStore.shouldBlockWhatsApp(this, contactName, kind)
            CallGuardStore.appendWaLog(this, contactName, kind, block)

            if (block) {
                // Cancel just this notification → dismisses the ring / heads-up.
                try { cancelNotification(sbn.key) } catch (_: Throwable) {}
                // For call notifications, also try to dismiss any paired
                // ongoing-call notification group so the call drops cleanly.
                if (kind == "call" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                    try {
                        activeNotifications
                            ?.filter { it.packageName == pkg }
                            ?.forEach { other ->
                                val oc = other.notification?.category
                                if (oc == Notification.CATEGORY_CALL) {
                                    try { cancelNotification(other.key) } catch (_: Throwable) {}
                                }
                            }
                    } catch (_: Throwable) {}
                }
            }
        } catch (_: Throwable) {
            // Never crash the listener — a crash would silently disable the guard.
        }
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        // Mark connectivity so the UI can show "WhatsApp Guard: ACTIVE".
        CallGuardStore.setBool(this, "wa_listener_connected", true)
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        CallGuardStore.setBool(this, "wa_listener_connected", false)
    }
}
