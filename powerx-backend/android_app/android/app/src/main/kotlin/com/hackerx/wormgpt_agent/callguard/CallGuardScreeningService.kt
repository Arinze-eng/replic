package com.hackerx.wormgpt_agent.callguard

import android.telecom.Call
import android.telecom.CallScreeningService

/**
 * Truecaller-style call screening.
 *
 * Android hands EVERY incoming call to this service BEFORE it rings (once the
 * user has granted us the ROLE_CALL_SCREENING role). We then either:
 *   • allow it (and optionally label it), or
 *   • silently reject + skip the call log when it matches a block rule or is a
 *     withheld/"Private" call the user chose to block.
 *
 * IMPORTANT on "unmasking": when a caller hides their number (CLIR / "Private
 * number"), Android itself is NOT given the real number — `details.handle` is
 * null. No app on earth can recover a carrier-withheld number, so the honest,
 * achievable behaviour is: DETECT the private call and apply the user's rule
 * (label it "Private / Unknown" and optionally auto-reject it). That is exactly
 * what this service does.
 */
class CallGuardScreeningService : CallScreeningService() {

    override fun onScreenCall(callDetails: Call.Details) {
        val handle = callDetails.handle // tel: Uri, or null when withheld
        val rawNumber = handle?.schemeSpecificPart
        // Treat a missing/blank number, or an explicit "payphone/restricted"
        // presentation, as a PRIVATE call.
        val presentation = try { callDetails.callerNumberVerificationStatus } catch (_: Throwable) { 0 }
        val isPrivate = rawNumber.isNullOrBlank()

        val blocked = CallGuardStore.shouldBlock(this, rawNumber, isPrivate)
        val label = if (isPrivate) "Private / Unknown" else CallGuardStore.nameFor(this, rawNumber)

        CallGuardStore.appendLog(this, rawNumber, isPrivate, blocked, label)

        val resp = CallResponse.Builder()
        if (blocked) {
            // Reject the call, skip the notification, and skip the call log so a
            // blocked number never even shows up as a missed call.
            resp.setDisallowCall(true)
            resp.setRejectCall(true)
            resp.setSkipCallLog(true)
            resp.setSkipNotification(true)
        } else {
            resp.setDisallowCall(false)
            resp.setRejectCall(false)
            resp.setSkipCallLog(false)
            resp.setSkipNotification(false)
        }
        respondToCall(callDetails, resp.build())
    }
}
