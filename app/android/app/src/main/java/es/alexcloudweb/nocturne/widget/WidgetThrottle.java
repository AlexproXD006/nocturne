package es.alexcloudweb.nocturne.widget;

/**
 * Decides when the large widget's live part (progress + current lyric line) is pushed from the playback
 * ticker: only while playing, only when something visible changed (a new whole second of progress or a new
 * lyric line), and never more often than {@link #MIN_INTERVAL_MS}. Pure, so it is unit tested.
 */
public final class WidgetThrottle {
    public static final long MIN_INTERVAL_MS = 900;

    private long lastPushAt = Long.MIN_VALUE / 2;
    private long lastSecond = -1;
    private int lastLyricIdx = Integer.MIN_VALUE;

    /** Forget what was pushed (call after a full update, so the next tick pushes). */
    public synchronized void reset() {
        lastPushAt = Long.MIN_VALUE / 2;
        lastSecond = -1;
        lastLyricIdx = Integer.MIN_VALUE;
    }

    /** True when a tick should be pushed; records it as pushed in that case. */
    public synchronized boolean shouldPush(long nowMs, boolean playing, boolean hasLargeWidget, long positionMs, int lyricIdx) {
        if (!playing || !hasLargeWidget) return false;
        if (nowMs - lastPushAt < MIN_INTERVAL_MS) return false;
        long sec = Math.max(0, positionMs) / 1000;
        if (sec == lastSecond && lyricIdx == lastLyricIdx) return false;
        lastPushAt = nowMs;
        lastSecond = sec;
        lastLyricIdx = lyricIdx;
        return true;
    }
}
