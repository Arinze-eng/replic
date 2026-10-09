package com.hackerx.wormgpt_agent.callguard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms the anti-background-kill foreground service after a reboot or app
 * update, but ONLY if the user previously turned the persistent guard ON.
 * This makes "keep running in the background" survive restarts — the user
 * still has full manual control (they disable it from the Phone Guard screen).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            if (CallGuardStore.getBool(context, "guard_persistent")) {
                try { GuardForegroundService.start(context) } catch (_: Throwable) {}
            }
        }
    }
}
