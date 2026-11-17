package es.alexcloudweb.nocturne.updates;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.regex.Pattern;

/** SharedPreferences for the update check: where to look and what we already notified about. */
public final class UpdatePrefs {
    private UpdatePrefs() {}

    static final String FILE = "nocturne_updates";
    static final String KEY_SERVER_URL = "server_url";
    static final String KEY_CHANNEL = "channel";
    static final String KEY_LAST_NOTIFIED = "last_notified_version";

    private static final Pattern CHANNEL = Pattern.compile("^[a-z0-9][a-z0-9-]{0,31}$");
    private static final Pattern VERSION = Pattern.compile("^[vV]?[0-9A-Za-z.+-]{1,64}$");

    static SharedPreferences prefs(@NonNull Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** Normalised http(s) base URL without trailing slashes, or null when unusable. */
    @Nullable
    public static String normaliseServerUrl(@Nullable String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        String lower = s.toLowerCase(java.util.Locale.ROOT);
        if (!(lower.startsWith("https://") || lower.startsWith("http://"))) return null;
        if (s.length() > 2048 || s.contains(" ") || s.contains("?") || s.contains("#")) return null;
        return s;
    }

    public static boolean isValidChannel(@Nullable String channel) {
        return channel != null && CHANNEL.matcher(channel).matches();
    }

    public static boolean isValidVersion(@Nullable String version) {
        return version != null && VERSION.matcher(version.trim()).matches();
    }

    static void save(@NonNull Context ctx, @NonNull String serverUrl, @NonNull String channel) {
        prefs(ctx).edit().putString(KEY_SERVER_URL, serverUrl).putString(KEY_CHANNEL, channel).apply();
    }

    static void clearTarget(@NonNull Context ctx) {
        prefs(ctx).edit().remove(KEY_SERVER_URL).remove(KEY_CHANNEL).apply();
    }

    @Nullable
    static String serverUrl(@NonNull Context ctx) {
        return normaliseServerUrl(prefs(ctx).getString(KEY_SERVER_URL, null));
    }

    @Nullable
    static String channel(@NonNull Context ctx) {
        String c = prefs(ctx).getString(KEY_CHANNEL, null);
        return isValidChannel(c) ? c : null;
    }

    @Nullable
    static String lastNotified(@NonNull Context ctx) {
        return prefs(ctx).getString(KEY_LAST_NOTIFIED, null);
    }

    static void setLastNotified(@NonNull Context ctx, @NonNull String version) {
        prefs(ctx).edit().putString(KEY_LAST_NOTIFIED, version).commit();
    }
}
