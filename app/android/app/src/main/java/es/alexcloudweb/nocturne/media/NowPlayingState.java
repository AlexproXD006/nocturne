package es.alexcloudweb.nocturne.media;

import android.net.Uri;
import android.os.SystemClock;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import org.json.JSONObject;

/**
 * Immutable snapshot of what the WebView player reports (title, position, flags...).
 *
 * <p>Built from the untrusted JS payload with strict, null-safe parsing: every field has a sane
 * default, numbers must be finite, the artwork must be an http(s) URL. Positions are stored in
 * milliseconds together with the {@link SystemClock#elapsedRealtime()} at which they were valid,
 * so the native side can extrapolate the position while playing without JS sending ticks.
 */
final class NowPlayingState {
    static final String REPEAT_OFF = "off";
    static final String REPEAT_ALL = "all";
    static final String REPEAT_ONE = "one";

    /** Upper bound for durations/positions (24 h): guards against garbage values. */
    private static final long MAX_MS = 24L * 60L * 60L * 1000L;
    private static final int MAX_TEXT = 512;

    @NonNull final String uid;
    @NonNull final String title;
    @NonNull final String artist;
    @NonNull final String album;
    @Nullable final Uri artworkUri;
    /** Duration in ms, or 0 when unknown. */
    final long durationMs;
    /** Position in ms at {@link #positionAtElapsedMs}. */
    final long positionMs;
    final long positionAtElapsedMs;
    final boolean playing;
    final boolean buffering;
    final boolean hasPrev;
    final boolean hasNext;
    final boolean liked;
    final boolean shuffle;
    @NonNull final String repeat;

    private NowPlayingState(
        @NonNull String uid,
        @NonNull String title,
        @NonNull String artist,
        @NonNull String album,
        @Nullable Uri artworkUri,
        long durationMs,
        long positionMs,
        long positionAtElapsedMs,
        boolean playing,
        boolean buffering,
        boolean hasPrev,
        boolean hasNext,
        boolean liked,
        boolean shuffle,
        @NonNull String repeat
    ) {
        this.uid = uid;
        this.title = title;
        this.artist = artist;
        this.album = album;
        this.artworkUri = artworkUri;
        this.durationMs = durationMs;
        this.positionMs = positionMs;
        this.positionAtElapsedMs = positionAtElapsedMs;
        this.playing = playing;
        this.buffering = buffering;
        this.hasPrev = hasPrev;
        this.hasNext = hasNext;
        this.liked = liked;
        this.shuffle = shuffle;
        this.repeat = repeat;
    }

    /** Parses the plugin call payload; never throws. Returns null for a null payload. */
    @Nullable
    static NowPlayingState fromJson(@Nullable JSONObject o) {
        if (o == null) return null;
        String title = text(o, "title", "");
        String artist = text(o, "artist", "");
        String album = text(o, "album", "");
        String id = text(o, "id", "");
        String uid = !id.isEmpty() ? "id:" + id : "t:" + title + "\u0000" + artist + "\u0000" + album;
        long durationMs = millis(number(o, "duration"));
        long positionMs = millis(number(o, "position"));
        if (durationMs > 0 && positionMs > durationMs) positionMs = durationMs;
        String repeat = text(o, "repeat", REPEAT_OFF);
        if (!REPEAT_ALL.equals(repeat) && !REPEAT_ONE.equals(repeat)) repeat = REPEAT_OFF;
        return new NowPlayingState(
            uid,
            title,
            artist,
            album,
            artwork(text(o, "artworkUrl", "")),
            durationMs,
            positionMs,
            SystemClock.elapsedRealtime(),
            bool(o, "playing"),
            bool(o, "buffering"),
            bool(o, "hasPrev"),
            bool(o, "hasNext"),
            bool(o, "liked"),
            bool(o, "shuffle"),
            repeat
        );
    }

    /** True while the position is advancing (playing and not stalled). */
    boolean isAdvancing() {
        return playing && !buffering;
    }

    /** The extrapolated position right now, clamped to [0, duration]. */
    long currentPositionMs() {
        long pos = positionMs;
        if (isAdvancing()) pos += Math.max(0L, SystemClock.elapsedRealtime() - positionAtElapsedMs);
        if (durationMs > 0 && pos > durationMs) pos = durationMs;
        return Math.max(0L, pos);
    }

    NowPlayingState withPlaying(boolean nextPlaying) {
        return new NowPlayingState(uid, title, artist, album, artworkUri, durationMs, currentPositionMs(),
            SystemClock.elapsedRealtime(), nextPlaying, buffering, hasPrev, hasNext, liked, shuffle, repeat);
    }

    NowPlayingState withPosition(long nextPositionMs) {
        long p = Math.max(0L, nextPositionMs);
        if (durationMs > 0 && p > durationMs) p = durationMs;
        return new NowPlayingState(uid, title, artist, album, artworkUri, durationMs, p,
            SystemClock.elapsedRealtime(), playing, buffering, hasPrev, hasNext, liked, shuffle, repeat);
    }

    NowPlayingState withLiked(boolean nextLiked) {
        return new NowPlayingState(uid, title, artist, album, artworkUri, durationMs, currentPositionMs(),
            SystemClock.elapsedRealtime(), playing, buffering, hasPrev, hasNext, nextLiked, shuffle, repeat);
    }

    NowPlayingState withShuffle(boolean nextShuffle) {
        return new NowPlayingState(uid, title, artist, album, artworkUri, durationMs, currentPositionMs(),
            SystemClock.elapsedRealtime(), playing, buffering, hasPrev, hasNext, liked, nextShuffle, repeat);
    }

    NowPlayingState withRepeat(@NonNull String nextRepeat) {
        return new NowPlayingState(uid, title, artist, album, artworkUri, durationMs, currentPositionMs(),
            SystemClock.elapsedRealtime(), playing, buffering, hasPrev, hasNext, liked, shuffle, nextRepeat);
    }

    /** off -> all -> one -> off, matching the app's cycleRepeat(). */
    @NonNull
    static String nextRepeat(@NonNull String mode) {
        if (REPEAT_OFF.equals(mode)) return REPEAT_ALL;
        if (REPEAT_ALL.equals(mode)) return REPEAT_ONE;
        return REPEAT_OFF;
    }

    /** Identity of the custom buttons: they are rebuilt only when this changes. */
    @NonNull
    String buttonsKey() {
        return liked + "|" + shuffle + "|" + repeat;
    }

    // ---------------------------------------------------------------------------------------------

    @NonNull
    private static String text(JSONObject o, String key, @NonNull String fallback) {
        Object v = o.opt(key);
        if (!(v instanceof String)) return fallback;
        String s = (String) v;
        return s.length() > MAX_TEXT ? s.substring(0, MAX_TEXT) : s;
    }

    private static double number(JSONObject o, String key) {
        Object v = o.opt(key);
        if (!(v instanceof Number)) return 0d;
        double d = ((Number) v).doubleValue();
        return Double.isNaN(d) || Double.isInfinite(d) ? 0d : d;
    }

    private static boolean bool(JSONObject o, String key) {
        Object v = o.opt(key);
        return v instanceof Boolean && (Boolean) v;
    }

    /** Seconds (JS) to clamped milliseconds. */
    private static long millis(double seconds) {
        if (!(seconds > 0)) return 0L;
        double ms = seconds * 1000d;
        return ms >= MAX_MS ? MAX_MS : Math.round(ms);
    }

    @Nullable
    private static Uri artwork(@NonNull String url) {
        if (url.isEmpty()) return null;
        try {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            if (scheme == null) return null;
            String s = scheme.toLowerCase(java.util.Locale.ROOT);
            return ("https".equals(s) || "http".equals(s)) && uri.getHost() != null ? uri : null;
        } catch (RuntimeException e) {
            return null;
        }
    }
}
