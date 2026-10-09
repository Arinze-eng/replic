package com.hackerx.wormgpt_agent

import android.annotation.SuppressLint
import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.ContactsContract
import java.io.File
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.hackerx.wormgpt_agent.callguard.CallGuardStore
import com.hackerx.wormgpt_agent.callguard.GuardForegroundService
import com.hackerx.wormgpt_agent.callguard.WhatsAppGuardService
import io.flutter.FlutterInjector
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hosts the Flutter UI and bridges the native Phone Guard
 * (CallScreeningService + WhatsApp NotificationListener + anti-kill foreground
 * service) over a MethodChannel.
 */
class MainActivity : FlutterActivity() {

    private val channel = "com.hackerx.wormgpt_agent/callguard"
    private val reqRole = 7711
    private val reqCallPerm = 7712
    private val reqContactsPerm = 7713
    private var pendingCallNumber: String? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.hackerx.wormgpt_agent/linux")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "primaryAbi" -> result.success(android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
                    "prepareRuntime" -> {
                        try {
                            val nativeDir = applicationInfo.nativeLibraryDir
                            val proot = File(nativeDir, "libproot.so")
                            val loader = File(nativeDir, "libproot-loader.so")
                            val runtimeTmp = File(cacheDir, "proot-tmp").apply { mkdirs() }
                            val rootfs = extractVersionedAsset(
                                FlutterInjector.instance().flutterLoader().getLookupKeyForAsset(
                                    "assets/linux/alpine-minirootfs-3.20.3-aarch64.tgz"
                                ),
                                File(filesDir, "linux-runtime/alpine-minirootfs-3.20.3-aarch64.tgz")
                            )
                            for (component in listOf(proot, loader)) {
                                if (!component.isFile || component.length() == 0L || !component.canExecute()) {
                                    throw IllegalStateException(
                                        "Bundled Linux runtime is not executable. Reinstall this APK and try Setup again."
                                    )
                                }
                            }
                            if (!runtimeTmp.isDirectory || !runtimeTmp.canWrite()) {
                                throw IllegalStateException("Linux runtime temporary directory is unavailable.")
                            }
                            result.success(mapOf(
                                "proot" to proot.absolutePath,
                                "loader" to loader.absolutePath,
                                "rootfs" to rootfs.absolutePath,
                                "tmpDir" to runtimeTmp.absolutePath,
                                "libraryDir" to nativeDir
                            ))
                        } catch (t: Throwable) {
                            result.error("LINUX_RUNTIME", t.message, null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    // ── role / capability ──────────────────────────────────
                    "isScreeningRoleHeld" -> result.success(isScreeningRoleHeld())
                    "requestScreeningRole" -> { requestScreeningRole(); result.success(true) }

                    // ── master toggles ─────────────────────────────────────
                    "setEnabled" -> {
                        CallGuardStore.setEnabled(this, call.argument<Boolean>("value") ?: false)
                        result.success(true)
                    }
                    "isEnabled" -> result.success(CallGuardStore.isEnabled(this))
                    "setBlockPrivate" -> {
                        CallGuardStore.setBlockPrivate(this, call.argument<Boolean>("value") ?: false)
                        result.success(true)
                    }
                    "isBlockPrivate" -> result.success(CallGuardStore.blockPrivate(this))

                    // ── generic bool flags (allowlist_enabled, wa_*, …) ─────
                    "getFlag" -> result.success(
                        CallGuardStore.getBool(this,
                            call.argument<String>("key") ?: "",
                            call.argument<Boolean>("def") ?: false))
                    "setFlag" -> {
                        CallGuardStore.setBool(this,
                            call.argument<String>("key") ?: "",
                            call.argument<Boolean>("value") ?: false)
                        result.success(true)
                    }

                    // ── generic string-array lists (allow_exact, wa_*_names) ─
                    "getList" -> result.success(
                        CallGuardStore.getArray(this, call.argument<String>("key") ?: ""))
                    "setList" -> {
                        CallGuardStore.setArray(this,
                            call.argument<String>("key") ?: "", strList(call))
                        result.success(true)
                    }

                    // ── block lists (legacy explicit getters/setters) ───────
                    "setExact" -> { CallGuardStore.setArray(this, "block_exact", strList(call)); result.success(true) }
                    "getExact" -> result.success(CallGuardStore.exactList(this))
                    "setPrefix" -> { CallGuardStore.setArray(this, "block_prefix", strList(call)); result.success(true) }
                    "getPrefix" -> result.success(CallGuardStore.prefixList(this))
                    "setRegex" -> { CallGuardStore.setArray(this, "block_regex", strList(call)); result.success(true) }
                    "getRegex" -> result.success(CallGuardStore.regexList(this))

                    // ── caller-id name cache (filled by Flutter from server) ─
                    "cacheName" -> {
                        CallGuardStore.putName(this,
                            call.argument<String>("number"),
                            call.argument<String>("name") ?: "")
                        result.success(true)
                    }

                    // ── on-device screened-call log ────────────────────────
                    "getLog" -> result.success(CallGuardStore.logJson(this))
                    "clearLog" -> { CallGuardStore.clearLog(this); result.success(true) }
                    "getWaLog" -> result.success(CallGuardStore.waLogJson(this))
                    "clearWaLog" -> { CallGuardStore.clearWaLog(this); result.success(true) }

                    // ── 💬 WhatsApp Guard: notification access ──────────────
                    "isNotifAccessGranted" -> result.success(isNotificationAccessGranted())
                    "requestNotifAccess" -> { openNotificationAccessSettings(); result.success(true) }
                    "isWaListenerConnected" ->
                        result.success(CallGuardStore.getBool(this, "wa_listener_connected"))

                    // ── 🛡️ Anti-background-kill foreground service ──────────
                    "isGuardPersistent" ->
                        result.success(CallGuardStore.getBool(this, "guard_persistent"))
                    "startPersistentGuard" -> { GuardForegroundService.start(this); result.success(true) }
                    "stopPersistentGuard" -> { GuardForegroundService.stop(this); result.success(true) }

                    // ── 🔋 Battery-optimisation exemption (helps anti-kill) ──
                    "isBatteryUnrestricted" -> result.success(isIgnoringBatteryOptimizations())
                    "requestBatteryUnrestricted" -> { requestIgnoreBatteryOptimizations(); result.success(true) }
                    "openAppSettings" -> { openAppSettings(); result.success(true) }

                    // ── 📇 Contacts picker (returns name+number list) ────────
                    "hasContactsPermission" -> result.success(hasContactsPermission())
                    "requestContactsPermission" -> { requestContactsPermission(); result.success(true) }
                    "readContacts" -> result.success(readContactsJson())

                    // ── 📞 Dialer: place an outgoing call ──────────────────
                    "canDirectCall" -> result.success(hasCallPermission())
                    "requestCallPermission" -> { requestCallPermission(); result.success(true) }
                    "placeCall" -> {
                        val number = call.argument<String>("number")?.trim().orEmpty()
                        if (number.isEmpty()) { result.success(false); return@setMethodCallHandler }
                        result.success(placeCall(number))
                    }
                    "openDialer" -> {
                        val number = call.argument<String>("number")?.trim().orEmpty()
                        openSystemDialer(number)
                        result.success(true)
                    }

                    else -> result.notImplemented()
                }
            }
    }

    private fun extractVersionedAsset(assetPath: String, target: File): File {
        if (!target.isFile || target.length() == 0L) {
            target.parentFile?.mkdirs()
            val partial = File(target.parentFile, "${target.name}.partial")
            partial.delete()
            assets.open(assetPath).use { input ->
                partial.outputStream().use { output -> input.copyTo(output) }
            }
            if (partial.length() < 1024L) {
                partial.delete()
                throw IllegalStateException("Bundled Alpine filesystem is invalid.")
            }
            target.delete()
            if (!partial.renameTo(target)) {
                partial.delete()
                throw IllegalStateException("Bundled Alpine filesystem could not be prepared.")
            }
        }
        return target
    }

    @Suppress("UNCHECKED_CAST")
    private fun strList(call: io.flutter.plugin.common.MethodCall): List<String> =
        (call.argument<List<String>>("items")) ?: emptyList()

    private fun isScreeningRoleHeld(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        val rm = getSystemService(RoleManager::class.java) ?: return false
        return rm.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING) &&
               rm.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
    }

    private fun requestScreeningRole() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val rm = getSystemService(RoleManager::class.java) ?: return
        if (rm.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING) &&
            !rm.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)) {
            val intent: Intent = rm.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
            startActivityForResult(intent, reqRole)
        }
    }

    // ── 💬 Notification access (WhatsApp Guard) ─────────────────────────────
    private fun isNotificationAccessGranted(): Boolean {
        return try {
            val enabled = Settings.Secure.getString(
                contentResolver, "enabled_notification_listeners") ?: ""
            val cn = ComponentName(this, WhatsAppGuardService::class.java)
            enabled.split(":").any {
                val c = ComponentName.unflattenFromString(it)
                c != null && c.packageName == packageName &&
                    c.className == WhatsAppGuardService::class.java.name
            } || enabled.contains(cn.flattenToString())
        } catch (_: Throwable) { false }
    }

    private fun openNotificationAccessSettings() {
        try {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Throwable) {
            try { startActivity(Intent(Settings.ACTION_SETTINGS)) } catch (_: Throwable) {}
        }
    }

    // ── 🔋 Battery optimisation ──────────────────────────────────────────────
    private fun isIgnoringBatteryOptimizations(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    @SuppressLint("BatteryLife")
    private fun requestIgnoreBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (isIgnoringBatteryOptimizations()) return
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:$packageName")))
        } catch (_: Throwable) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Throwable) {}
        }
    }

    private fun openAppSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:$packageName"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Throwable) {}
    }

    // ── 📇 Contacts ───────────────────────────────────────────────────────────
    private fun hasContactsPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_CONTACTS) ==
            PackageManager.PERMISSION_GRANTED

    private fun requestContactsPermission() {
        if (!hasContactsPermission()) {
            ActivityCompat.requestPermissions(
                this, arrayOf(android.Manifest.permission.READ_CONTACTS), reqContactsPerm)
        }
    }

    /** Returns a JSON array string: [{"name":"…","number":"…"}, …] (deduped). */
    private fun readContactsJson(): String {
        if (!hasContactsPermission()) return "[]"
        val out = JSONArray()
        val seen = HashSet<String>()
        try {
            val cursor = contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                ),
                null, null,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
            )
            cursor?.use { c ->
                val nameIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val numIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                while (c.moveToNext()) {
                    val name = if (nameIdx >= 0) c.getString(nameIdx) ?: "" else ""
                    val num = if (numIdx >= 0) c.getString(numIdx) ?: "" else ""
                    val key = (name + "|" + num).lowercase()
                    if (name.isBlank() && num.isBlank()) continue
                    if (!seen.add(key)) continue
                    out.put(JSONObject().apply {
                        put("name", name)
                        put("number", num)
                    })
                }
            }
        } catch (_: Throwable) {}
        return out.toString()
    }

    // ── 📞 Outgoing-call helpers ───────────────────────────────────────────
    private fun hasCallPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, android.Manifest.permission.CALL_PHONE) ==
            PackageManager.PERMISSION_GRANTED

    private fun requestCallPermission() {
        if (!hasCallPermission()) {
            ActivityCompat.requestPermissions(
                this, arrayOf(android.Manifest.permission.CALL_PHONE), reqCallPerm)
        }
    }

    private fun placeCall(number: String): Boolean {
        val uri = Uri.parse("tel:" + Uri.encode(number))
        return if (hasCallPermission()) {
            try {
                startActivity(Intent(Intent.ACTION_CALL, uri))
                true
            } catch (_: Throwable) {
                openSystemDialer(number); false
            }
        } else {
            pendingCallNumber = number
            requestCallPermission()
            openSystemDialer(number) // graceful fallback for THIS attempt
            false
        }
    }

    private fun openSystemDialer(number: String) {
        try {
            val uri = Uri.parse("tel:" + Uri.encode(number))
            startActivity(Intent(Intent.ACTION_DIAL, uri))
        } catch (_: Throwable) { /* nothing we can do */ }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == reqCallPerm &&
            grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            pendingCallNumber?.let { num ->
                pendingCallNumber = null
                try { startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(num)))) }
                catch (_: Throwable) { openSystemDialer(num) }
            }
        }
    }
}
