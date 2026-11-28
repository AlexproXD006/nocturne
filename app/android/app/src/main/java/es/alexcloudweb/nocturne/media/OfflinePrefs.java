package es.alexcloudweb.nocturne.media;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.HashSet;
import java.util.Set;

/**
 * Offline settings and the pinned (downloaded) track ids, kept natively so the service, the download
 * service and the evictor work with the app closed. The WebView pushes changes with
 * {@code NocturneOffline.configure}.
 */
final class OfflinePrefs {
    private static final String PREFS = "nocturne_offline";
    private static final String K_TRACKS = "autoTracks";
    private static final String K_BYTES = "autoBytes";
    private static final String K_WIFI_ONLY = "wifiOnly";
    private static final String K_PREFETCH_WIFI = "prefetchWifiOnly";
    private static final String K_LIMIT = "limitBytes";
    private static final String K_PINNED = "pinned";

    private static volatile Set<String> pinnedCache;

    private OfflinePrefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static CachePolicy policy(Context c) {
        SharedPreferences s = sp(c);
        long bytes = CachePolicy.sanitizeBytes(s.getLong(K_BYTES, 0));
        if (bytes > 0) return CachePolicy.bytes(bytes);
        return CachePolicy.tracks(s.getInt(K_TRACKS, CachePolicy.DEFAULT_TRACKS));
    }

    /** Downloads over Wi-Fi (unmetered) only. Default on. */
    static boolean downloadsWifiOnly(Context c) {
        return sp(c).getBoolean(K_WIFI_ONLY, true);
    }

    /** Prefetching the next queued track over Wi-Fi only. Default on. */
    static boolean prefetchWifiOnly(Context c) {
        return sp(c).getBoolean(K_PREFETCH_WIFI, true);
    }

    /** Downloads storage limit in bytes (0 = none). */
    static long limitBytes(Context c) {
        return sp(c).getLong(K_LIMIT, 0);
    }

    static void save(Context c, int tracks, long bytes, boolean wifiOnly, boolean prefetchWifi, long limit) {
        sp(c).edit()
            .putInt(K_TRACKS, CachePolicy.sanitizeTracks(tracks))
            .putLong(K_BYTES, CachePolicy.sanitizeBytes(bytes))
            .putBoolean(K_WIFI_ONLY, wifiOnly)
            .putBoolean(K_PREFETCH_WIFI, prefetchWifi)
            .putLong(K_LIMIT, Math.max(0, limit))
            .apply();
    }

    static synchronized Set<String> pinned(Context c) {
        if (pinnedCache == null) pinnedCache = new HashSet<>(sp(c).getStringSet(K_PINNED, new HashSet<>()));
        return pinnedCache;
    }

    static synchronized void pin(Context c, String id) {
        Set<String> p = new HashSet<>(pinned(c));
        if (p.add(id)) store(c, p);
    }

    static synchronized void unpin(Context c, String id) {
        Set<String> p = new HashSet<>(pinned(c));
        if (p.remove(id)) store(c, p);
    }

    static synchronized void unpinAll(Context c) {
        store(c, new HashSet<>());
    }

    private static void store(Context c, Set<String> p) {
        pinnedCache = p;
        sp(c).edit().putStringSet(K_PINNED, new HashSet<>(p)).apply();
    }
}
