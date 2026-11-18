package es.alexcloudweb.nocturne.media;

import androidx.annotation.Nullable;

/**
 * Counts how long one track was really listened to (wall playback, seeks excluded) and decides whether it
 * counts as a play: 30 s, or half of the track. Pure Java (unit-tested); fed once a second by the service.
 */
final class ListenTracker {
    /** A tick further apart than this is a seek / stall, not listening. */
    static final long MAX_STEP_MS = 2_500;

    static final class Listen {
        final String trackId;
        final long seconds;
        final long startedAtMs;

        Listen(String trackId, long seconds, long startedAtMs) {
            this.trackId = trackId;
            this.seconds = seconds;
            this.startedAtMs = startedAtMs;
        }
    }

    private String trackId = "";
    private long durationMs;
    private long startedAtMs;
    private long listenedMs;
    private long lastPositionMs = -1;

    void start(String trackId, long durationMs, long nowMs) {
        this.trackId = trackId == null ? "" : trackId;
        this.durationMs = Math.max(0, durationMs);
        this.startedAtMs = nowMs;
        this.listenedMs = 0;
        this.lastPositionMs = -1;
    }

    void setDuration(long durationMs) {
        if (durationMs > 0) this.durationMs = durationMs;
    }

    void tick(long positionMs, boolean playing) {
        if (!playing) {
            lastPositionMs = positionMs;
            return;
        }
        if (lastPositionMs >= 0) {
            long delta = positionMs - lastPositionMs;
            if (delta > 0 && delta <= MAX_STEP_MS) listenedMs += delta;
        }
        lastPositionMs = positionMs;
    }

    long listenedSeconds() {
        return listenedMs / 1000;
    }

    /** Ends the listen; returns it when it counts as a play, else null. The tracker is reset. */
    @Nullable
    Listen finish() {
        Listen out = null;
        long seconds = listenedMs / 1000;
        if (!trackId.isEmpty() && (seconds >= 30 || (durationMs > 0 && listenedMs * 2 >= durationMs))) {
            out = new Listen(trackId, seconds, startedAtMs);
        }
        trackId = "";
        listenedMs = 0;
        lastPositionMs = -1;
        return out;
    }
}
