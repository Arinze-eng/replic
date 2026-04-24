package com.sjsu.boreas.vpn;

import android.net.Uri;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Minimal VLESS URI parser and V2Ray JSON config builder.
 *
 * Input example:
 * vless://UUID@host:443?encryption=none&host=example.com&path=%2F&security=tls&sni=example.com&type=ws#name
 */
public final class V2RayConfigUtil {

    private V2RayConfigUtil() {}

    public static class VlessProfile {
        public String uuid;
        public String address;
        public int port;
        public String security; // tls / none
        public String sni;
        public String wsHost;
        public String wsPath;
        public String type; // ws
        public String name;
    }

    public static VlessProfile parseVless(String vlessUri) {
        if (vlessUri == null) throw new IllegalArgumentException("vless uri is null");
        if (!vlessUri.startsWith("vless://")) throw new IllegalArgumentException("not vless:// uri");

        // Uri.parse can choke on some chars; normalize.
        Uri uri = Uri.parse(vlessUri);

        VlessProfile p = new VlessProfile();
        p.uuid = uri.getUserInfo();
        if (p.uuid == null || p.uuid.trim().isEmpty()) {
            // Android Uri sometimes doesn't populate userInfo; fallback parsing
            String s = vlessUri.substring("vless://".length());
            int at = s.indexOf('@');
            if (at > 0) p.uuid = s.substring(0, at);
        }

        p.address = uri.getHost();
        p.port = uri.getPort() > 0 ? uri.getPort() : 443;

        Map<String, String> q = splitQuery(uri);
        p.security = getOr(q, "security", "tls");
        p.sni = getOr(q, "sni", "");
        p.wsHost = getOr(q, "host", "");
        p.wsPath = urlDecode(getOr(q, "path", "/"));
        p.type = getOr(q, "type", "ws");

        String frag = uri.getFragment();
        p.name = frag != null ? frag : "vless";

        if (p.uuid == null || p.uuid.trim().isEmpty()) throw new IllegalArgumentException("missing uuid");
        if (p.address == null || p.address.trim().isEmpty()) throw new IllegalArgumentException("missing host");
        return p;
    }

    private static String getOr(Map<String, String> m, String k, String d) {
        String v = m.get(k);
        return v == null ? d : v;
    }

    private static String urlDecode(String s) {
        try {
            return URLDecoder.decode(s, StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return s;
        }
    }

    private static Map<String, String> splitQuery(Uri uri) {
        Map<String, String> out = new HashMap<>();
        for (String key : uri.getQueryParameterNames()) {
            out.put(key, uri.getQueryParameter(key));
        }
        return out;
    }

    /**
     * Build a simple V2Ray config that routes all traffic through a local SOCKS inbound.
     *
     * Note: When using libv2ray + VpnService support, the core will request a TUN interface
     * via the V2Ray callbacks (setup/protect). This config is compatible with typical V2RayNG/Actinium patterns.
     */
    public static String buildV2RayConfigJson(VlessProfile p) {
        // Keep it conservative: one outbound (vless), freedom for direct (used for DNS if needed), and a simple routing rule.
        // DNS: use system default; you can customize later.

        String sni = (p.sni != null && !p.sni.isEmpty()) ? p.sni : p.wsHost;
        if (sni == null) sni = "";

        // Java string JSON building (manual) to avoid extra deps.
        return "{"
                + "\"log\":{\"loglevel\":\"warning\"},"
                + "\"inbounds\":["
                + "{\"port\":10808,\"listen\":\"127.0.0.1\",\"protocol\":\"socks\",\"settings\":{\"udp\":true}}"
                + "],"
                + "\"outbounds\":["
                + "{\"protocol\":\"vless\",\"tag\":\"proxy\",\"settings\":{\"vnext\":[{\"address\":\"" + esc(p.address) + "\",\"port\":" + p.port + ",\"users\":[{\"id\":\"" + esc(p.uuid) + "\",\"encryption\":\"none\"}]}]},"
                + "\"streamSettings\":{\"network\":\"ws\",\"security\":\"" + esc(p.security) + "\",\"tlsSettings\":{\"allowInsecure\":true,\"serverName\":\"" + esc(sni) + "\"},\"wsSettings\":{\"path\":\"" + esc(p.wsPath) + "\",\"headers\":{\"Host\":\"" + esc(p.wsHost) + "\"}}}},"
                + "{\"protocol\":\"freedom\",\"tag\":\"direct\"},"
                + "{\"protocol\":\"blackhole\",\"tag\":\"block\"}"
                + "],"
                + "\"routing\":{\"domainStrategy\":\"AsIs\",\"rules\":[{\"type\":\"field\",\"inboundTag\":[\"socks-in\"],\"outboundTag\":\"proxy\"}]}"
                + "}";
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
