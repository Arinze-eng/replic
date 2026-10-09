package com.hackerx.wormgpt_agent.callguard

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Shared, file-backed rule store for the Phone Guard.
 *
 * Flutter writes the rules into the SAME SharedPreferences file that the
 * native CallScreeningService + NotificationListenerService read, so every
 * decision happens with zero IPC at event time (the services must answer in
 * a few ms).
 *
 * Stored keys (all in prefs file "wormgpt_callguard"):
 *   enabled              : Boolean — master on/off (call screening)
 *   block_private        : Boolean — reject withheld/unknown/"Private" calls
 *   block_exact          : JSON array of normalised digit strings
 *   block_prefix         : JSON array of digit prefixes (e.g. "23480")
 *   block_regex          : JSON array of raw regex patterns (matched on digits)
 *   names                : JSON object { "<digits>": "Name" } cached caller IDs
 *   log                  : JSON array (capped) of recent screened CALL events
 *
 *   ── New: allow-list (whitelist) mode for normal calls ──
 *   allowlist_enabled    : Boolean — when ON, ONLY allow-listed numbers ring
 *   allow_exact          : JSON array of normalised digit strings (allowed)
 *
 *   ── New: WhatsApp guard (notification-listener powered) ──
 *   wa_enabled           : Boolean — master WhatsApp call/audio guard switch
 *   wa_block_unknown     : Boolean — block WhatsApp calls from contacts NOT on
 *                                    the WhatsApp allow-list (i.e. "unknown")
 *   wa_block_names       : JSON array of contact NAMES to block on WhatsApp
 *   wa_allow_names       : JSON array of contact NAMES allowed on WhatsApp
 *                          (only consulted when wa_block_unknown is ON)
 *   wa_block_calls       : Boolean — dismiss WhatsApp voice/video call notifs
 *   wa_block_audio       : Boolean — dismiss WhatsApp voice-message notifs
 *   wa_log               : JSON array (capped) of recent WhatsApp guard events
 *
 *   ── New: anti-background-kill ──
 *   guard_persistent     : Boolean — keep the foreground guard service alive so
 *                                    Android/OEM battery managers can't silently
 *                                    kill the guard; user must turn it off here.
 */
object CallGuardStore {
    const val PREFS = "wormgpt_callguard"

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ── master / call screening ────────────────────────────────────────────
    fun isEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean("enabled", false)
    fun blockPrivate(ctx: Context): Boolean = prefs(ctx).getBoolean("block_private", false)

    fun setEnabled(ctx: Context, v: Boolean) =
        prefs(ctx).edit().putBoolean("enabled", v).apply()

    fun setBlockPrivate(ctx: Context, v: Boolean) =
        prefs(ctx).edit().putBoolean("block_private", v).apply()

    // ── bool helpers ─────────────────────────────────────────────────────────
    fun getBool(ctx: Context, key: String, def: Boolean = false): Boolean =
        prefs(ctx).getBoolean(key, def)

    fun setBool(ctx: Context, key: String, v: Boolean) =
        prefs(ctx).edit().putBoolean(key, v).apply()

    // ── string-array helpers ──────────────────────────────────────────────────
    private fun arr(ctx: Context, key: String): List<String> {
        val raw = prefs(ctx).getString(key, "[]") ?: "[]"
        return try {
            val a = JSONArray(raw)
            (0 until a.length()).map { a.getString(it) }
        } catch (_: Exception) { emptyList() }
    }

    fun setArray(ctx: Context, key: String, items: List<String>) {
        val a = JSONArray()
        items.forEach { a.put(it) }
        prefs(ctx).edit().putString(key, a.toString()).apply()
    }

    fun getArray(ctx: Context, key: String): List<String> = arr(ctx, key)

    fun exactList(ctx: Context) = arr(ctx, "block_exact")
    fun prefixList(ctx: Context) = arr(ctx, "block_prefix")
    fun regexList(ctx: Context) = arr(ctx, "block_regex")
    fun allowExactList(ctx: Context) = arr(ctx, "allow_exact")

    /** Normalise a raw number to a bare digit string (drops +, spaces, dashes). */
    fun digits(raw: String?): String = (raw ?: "").replace(Regex("[^0-9]"), "")

    /** Returns a human label for a known number, or null. */
    fun nameFor(ctx: Context, raw: String?): String? {
        val d = digits(raw)
        if (d.isEmpty()) return null
        return try {
            val obj = JSONObject(prefs(ctx).getString("names", "{}") ?: "{}")
            if (obj.has(d)) obj.getString(d) else null
        } catch (_: Exception) { null }
    }

    /** Cache a resolved caller name (called by Flutter after a server lookup). */
    fun putName(ctx: Context, raw: String?, name: String) {
        val d = digits(raw)
        if (d.isEmpty()) return
        val obj = try { JSONObject(prefs(ctx).getString("names", "{}") ?: "{}") }
                  catch (_: Exception) { JSONObject() }
        obj.put(d, name)
        prefs(ctx).edit().putString("names", obj.toString()).apply()
    }

    /**
     * Core decision: should this incoming PHONE call be BLOCKED?
     * @param isPrivate true when the OS delivered no number (withheld / payphone).
     *
     * Rule precedence:
     *   1. Guard disabled            → never block.
     *   2. Private call              → block only if "block private" is ON.
     *   3. Allow-list (whitelist) ON → block EVERYTHING except allow-listed
     *      numbers (this is the strongest "only these people can call me" mode).
     *   4. Otherwise                 → block if it matches exact/prefix/regex.
     */
    fun shouldBlock(ctx: Context, raw: String?, isPrivate: Boolean): Boolean {
        if (!isEnabled(ctx)) return false
        if (isPrivate) return blockPrivate(ctx)

        val d = digits(raw)
        if (d.isEmpty()) return blockPrivate(ctx)

        // Whitelist mode: only allow-listed numbers get through.
        if (getBool(ctx, "allowlist_enabled")) {
            val allowed = allowExactList(ctx).any { digits(it) == d }
            return !allowed
        }

        if (exactList(ctx).any { digits(it) == d }) return true
        if (prefixList(ctx).any { p -> d.startsWith(digits(p)) }) return true
        for (pat in regexList(ctx)) {
            try { if (Regex(pat).containsMatchIn(d)) return true } catch (_: Exception) {}
        }
        return false
    }

    // ── 💬 WhatsApp guard decision ─────────────────────────────────────────────
    /**
     * Should this WhatsApp event (call / audio) be dismissed?
     * @param contactName the caller/sender display name extracted from the notif.
     * @param kind        "call" or "audio".
     *
     * Rule precedence:
     *   1. WA guard disabled                       → never block.
     *   2. This kind (call/audio) not guarded       → never block.
     *   3. Name on the WA block list                → block.
     *   4. "Block unknown" ON and name NOT on the
     *      WA allow list                            → block.
     *   5. Otherwise                                → allow.
     */
    fun shouldBlockWhatsApp(ctx: Context, contactName: String?, kind: String): Boolean {
        if (!getBool(ctx, "wa_enabled")) return false
        if (kind == "call" && !getBool(ctx, "wa_block_calls", true)) return false
        if (kind == "audio" && !getBool(ctx, "wa_block_audio")) return false

        val name = (contactName ?: "").trim()
        val nameLc = name.lowercase()

        // Explicit block list (case-insensitive substring match, robust to the
        // "Name: message" / "Name is calling…" wrappers WhatsApp uses).
        val blockNames = arr(ctx, "wa_block_names")
        if (blockNames.any { it.trim().isNotEmpty() && nameLc.contains(it.trim().lowercase()) }) {
            return true
        }

        // Block-unknown mode: anyone not on the allow list is blocked.
        if (getBool(ctx, "wa_block_unknown")) {
            val allowNames = arr(ctx, "wa_allow_names")
            val allowed = name.isNotEmpty() &&
                allowNames.any { it.trim().isNotEmpty() && nameLc.contains(it.trim().lowercase()) }
            return !allowed
        }
        return false
    }

    // ── on-device CALL log ─────────────────────────────────────────────────────
    fun appendLog(ctx: Context, number: String?, isPrivate: Boolean, blocked: Boolean, label: String?) {
        appendToLog(ctx, "log", JSONObject().apply {
            put("number", number ?: "")
            put("private", isPrivate)
            put("blocked", blocked)
            put("label", label ?: "")
            put("at", System.currentTimeMillis())
        })
    }

    fun logJson(ctx: Context): String = prefs(ctx).getString("log", "[]") ?: "[]"
    fun clearLog(ctx: Context) = prefs(ctx).edit().putString("log", "[]").apply()

    // ── on-device WHATSAPP log ──────────────────────────────────────────────────
    fun appendWaLog(ctx: Context, name: String?, kind: String, blocked: Boolean) {
        appendToLog(ctx, "wa_log", JSONObject().apply {
            put("name", name ?: "")
            put("kind", kind)
            put("blocked", blocked)
            put("at", System.currentTimeMillis())
        })
    }

    fun waLogJson(ctx: Context): String = prefs(ctx).getString("wa_log", "[]") ?: "[]"
    fun clearWaLog(ctx: Context) = prefs(ctx).edit().putString("wa_log", "[]").apply()

    /** Append an event to a capped (last 100, newest-first) JSON-array log. */
    private fun appendToLog(ctx: Context, key: String, e: JSONObject) {
        val a = try { JSONArray(prefs(ctx).getString(key, "[]") ?: "[]") }
                catch (_: Exception) { JSONArray() }
        val merged = JSONArray()
        merged.put(e)
        for (i in 0 until minOf(a.length(), 99)) merged.put(a.get(i))
        prefs(ctx).edit().putString(key, merged.toString()).apply()
    }
}
