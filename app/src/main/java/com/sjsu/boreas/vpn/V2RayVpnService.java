package com.sjsu.boreas.vpn;

import android.app.Service;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import androidx.annotation.Nullable;

import java.io.File;

import libv2ray.Libv2ray;
import libv2ray.V2RayCallbacks;
import libv2ray.V2RayVPNServiceSupportsSet;

/**
 * A minimal V2Ray Core tunnel using Android VpnService + libv2ray.
 *
 * IMPORTANT:
 * - You must place a compatible libv2ray.aar into app/libs (see FIX_NOTES_VPN.md).
 * - The user MUST grant VPN permission (VpnService.prepare).
 */
public class V2RayVpnService extends VpnService {

    public static final String TAG = "BOREAS_VPN";

    public static final String ACTION_START = "com.sjsu.boreas.vpn.action.START";
    public static final String ACTION_STOP  = "com.sjsu.boreas.vpn.action.STOP";

    public static final String EXTRA_VLESS_URI = "extra_vless_uri";

    private final Object lock = new Object();

    private libv2ray.V2RayPoint v2rayPoint;
    private ParcelFileDescriptor vpnInterface;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            v2rayPoint = Libv2ray.newV2RayPoint();
            v2rayPoint.setPackageName(getPackageName());
            v2rayPoint.setCallbacks(new Callback());
            v2rayPoint.setVpnSupportSet(new Callback());
        } catch (Throwable t) {
            Log.e(TAG, "Failed to init libv2ray. Is libv2ray.aar present?", t);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return Service.START_NOT_STICKY;
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopV2Ray();
            return Service.START_NOT_STICKY;
        }
        if (ACTION_START.equals(action)) {
            String vless = intent.getStringExtra(EXTRA_VLESS_URI);
            startV2Ray(vless);
            return Service.START_STICKY;
        }
        return Service.START_NOT_STICKY;
    }

    @Override
    public void onRevoke() {
        stopV2Ray();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return super.onBind(intent);
    }

    private void startV2Ray(String vlessUri) {
        synchronized (lock) {
            if (v2rayPoint == null) {
                Log.e(TAG, "v2rayPoint is null");
                return;
            }
            if (v2rayPoint.isRunning()) {
                Log.i(TAG, "V2Ray already running");
                return;
            }

            try {
                V2RayConfigUtil.VlessProfile p = V2RayConfigUtil.parseVless(vlessUri);
                String config = V2RayConfigUtil.buildV2RayConfigJson(p);

                // If you have geoip/geosite files on storage, you can override them (optional)
                tryOverrideAssets();

                v2rayPoint.setConfigureFile("V2Ray_internal/ConfigureFileContent");
                v2rayPoint.setConfigureFileContent(config);

                Log.i(TAG, "Starting V2Ray core with profile: " + p.name);
                v2rayPoint.runLoop();
            } catch (Throwable t) {
                Log.e(TAG, "Failed to start V2Ray", t);
            }
        }
    }

    private void stopV2Ray() {
        synchronized (lock) {
            try {
                if (v2rayPoint != null && v2rayPoint.isRunning()) {
                    v2rayPoint.stopLoop();
                }
            } catch (Throwable t) {
                Log.e(TAG, "Error stopping V2Ray", t);
            }

            try {
                if (vpnInterface != null) {
                    vpnInterface.close();
                }
            } catch (Exception ignored) {}
            vpnInterface = null;

            stopSelf();
        }
    }

    private void tryOverrideAssets() {
        try {
            Libv2ray.clearAssetsOverride("geoip.dat");
            Libv2ray.clearAssetsOverride("geosite.dat");

            File dir = getExternalFilesDir(null);
            if (dir == null) return;
            File geoip = new File(dir, "geoip.dat");
            File geosite = new File(dir, "geosite.dat");
            if (geoip.canRead()) Libv2ray.setAssetsOverride("geoip.dat", geoip.getAbsolutePath());
            if (geosite.canRead()) Libv2ray.setAssetsOverride("geosite.dat", geosite.getAbsolutePath());
        } catch (Throwable ignored) {
        }
    }

    private class Callback implements V2RayCallbacks, V2RayVPNServiceSupportsSet {
        @Override
        public long shutdown() {
            return 0;
        }

        @Override
        public long getVPNFd() {
            if (vpnInterface == null) return -1;
            return vpnInterface.getFd();
        }

        @Override
        public long prepare() {
            // Called by core when it needs VPN to be ready.
            // If permission is not granted, VpnService.prepare() in UI will return an Intent.
            return 1;
        }

        @Override
        public long protect(long socket) {
            return protect((int) socket) ? 0 : 1;
        }

        @Override
        public long onEmitStatus(long code, String msg) {
            Log.d(TAG, "v2ray: " + msg);
            return 0;
        }

        @Override
        public long setup(String parameters) {
            try {
                Log.i(TAG, "VPN setup params: " + parameters);
                Builder builder = new Builder();

                // Parameters format used by libv2ray implementations:
                // "m,1500 a,10.0.0.2,32 r,0.0.0.0,0 ..."
                String[] parts = parameters.split(" ");
                for (String part : parts) {
                    String[] seg = part.split(",");
                    if (seg.length == 0) continue;
                    char t = seg[0].charAt(0);
                    if (t == 'm' && seg.length >= 2) {
                        builder.setMtu(Integer.parseInt(seg[1]));
                    } else if (t == 'a' && seg.length >= 3) {
                        builder.addAddress(seg[1], Integer.parseInt(seg[2]));
                    } else if (t == 'r' && seg.length >= 3) {
                        builder.addRoute(seg[1], Integer.parseInt(seg[2]));
                    } else if (t == 's' && seg.length >= 2) {
                        builder.addSearchDomain(seg[1]);
                    }
                }

                // Optional: set a session name
                builder.setSession("BoreasV2Ray");

                // DNS servers (basic defaults)
                builder.addDnsServer("1.1.1.1");
                builder.addDnsServer("8.8.8.8");

                // Establish
                if (vpnInterface != null) {
                    try { vpnInterface.close(); } catch (Exception ignored) {}
                }
                vpnInterface = builder.establish();

                return 0;
            } catch (Throwable t) {
                Log.e(TAG, "VPN setup failed", t);
                return -1;
            }
        }
    }
}
