package es.alexcloudweb.nocturne.media;

import android.content.Context;

/** Remembers the "lyric line in the car" switch for a service started before the WebView said anything. */
final class LyricsPref {
    private static final String PREFS = "nocturne_native_prefs";
    private static final String KEY = "lyricsInCar";

    private LyricsPref() {}

    static void set(Context ctx, boolean on) {
        if (ctx != null) ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, on).apply();
    }

    static boolean get(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, false);
    }
}
