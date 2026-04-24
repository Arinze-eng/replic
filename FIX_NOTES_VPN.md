# Boreas – VPN Tunnel (V2Ray Core) integration notes

## What you asked for
A real VPN tunnel using **V2Ray Core (libv2ray)**, with an in-app button to turn the VPN **ON/OFF**.

## What I implemented in this repo
### 1) VPN service (Android VpnService)
- Added `com.sjsu.boreas.vpn.V2RayVpnService` (Java)
- Registered it in `AndroidManifest.xml` with `android.permission.BIND_VPN_SERVICE`

### 2) VLESS profile parsing + config
- Added `com.sjsu.boreas.vpn.V2RayConfigUtil`
- It parses a `vless://...` link and builds a basic V2Ray JSON config.

### 3) UI toggle button
- Added a button in **Settings** screen (`activity_settings.xml`) with id `vpn_toggle_button`
- Wired in `SettingsActivity`:
  - asks user for VPN permission (`VpnService.prepare`)
  - starts/stops `V2RayVpnService`
  - uses your provided VLESS URI as default.

## IMPORTANT: libv2ray.aar is auto-downloaded (keeps zip small)
V2Ray core is a native/go library and is large (~60MB). To keep your **project zip under 10MB**, I did **NOT** bundle it.

Instead, the Gradle build auto-downloads it into:
- `app/libs/libv2ray.aar`

from:
- `https://github.com/2dust/AndroidLibV2rayLite/releases/download/v5.49.0/libv2ray.aar`

So all you need to do is build the app normally (Android Studio / Gradle) and it will fetch the AAR automatically.

(If you prefer offline builds, you can still manually place `libv2ray.aar` in `app/libs/`.)

### Licensing warning
Some upstream Android V2Ray projects are **GPL**. If you copy their AAR or source directly, it may impose GPL obligations on your app.
- If you care about closed-source distribution, you must choose a core build / license path carefully.

## Your server URI
Currently hardcoded in `SettingsActivity` as `DEFAULT_VLESS_URI`:

vless://a6f1755f-0140-4bea-8727-0db1bed7c4df@172.67.187.6:443?allowInsecure=1&encryption=none&host=juzi.qea.ccwu.cc&path=%2F&security=tls&sni=juzi.qea.ccwu.cc&type=ws#vless-SG

(You can later move it into SharedPreferences + add an input field.)

## How to test
1. Put `libv2ray.aar` into `app/libs/`
2. Open project in Android Studio, Sync Gradle
3. Run app → Settings → tap **VPN: OFF**
4. Accept Android VPN permission prompt
5. Button changes to **VPN: ON** and service starts

## Next improvements (recommended)
- Add a real status indicator (running/not running) instead of relying on button text.
- Save VPN config in SharedPreferences + allow editing multiple profiles.
- Add a foreground notification while VPN is running (Android will kill background VPN services otherwise on newer phones).
