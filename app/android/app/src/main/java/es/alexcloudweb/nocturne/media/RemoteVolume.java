package es.alexcloudweb.nocturne.media;

/**
 * Volume of the remote Connect device as the system sees it: integer steps 0..{@link #MAX_STEPS}
 * (Android shows a slider with that many notches) against the 0..1 volume Connect uses.
 *
 * <p>Pure logic (no Android types) so it is unit-tested. Hardware key presses apply at once
 * ("optimistic") and for {@link #HOLD_MS} afterwards state pushed from the WebView is ignored, because
 * it can still carry the value from before the key press (the WebView round trip lags behind).
 */
final class RemoteVolume {
    static final int MAX_STEPS = 20;
    static final long HOLD_MS = 1200;

    private int step;
    private boolean muted;
    private long holdUntil;

    /** 0..1 to 0..MAX_STEPS (rounded, clamped; NaN is 0). */
    static int toStep(double volume) {
        if (Double.isNaN(volume)) return 0;
        long s = Math.round(volume * MAX_STEPS);
        return (int) Math.min(MAX_STEPS, Math.max(0, s));
    }

    /** 0..MAX_STEPS to 0..1 (clamped). */
    static double fromStep(int step) {
        return Math.min(MAX_STEPS, Math.max(0, step)) / (double) MAX_STEPS;
    }

    int step() {
        return step;
    }

    boolean muted() {
        return muted;
    }

    /** Adopts the remote device's real state. Returns true when the visible state changed. */
    boolean fromRemote(double volume, boolean isMuted, long nowMs) {
        if (nowMs < holdUntil) return false;
        int s = toStep(volume);
        boolean changed = s != step || isMuted != muted;
        step = s;
        muted = isMuted;
        return changed;
    }

    /** A key press / slider move on this phone. Returns true when the step changed. */
    boolean userSet(int target, long nowMs) {
        holdUntil = nowMs + HOLD_MS;
        int s = Math.min(MAX_STEPS, Math.max(0, target));
        boolean changed = s != step;
        step = s;
        return changed;
    }

    /** User mute toggle. Returns true when it changed. */
    boolean userMute(boolean isMuted, long nowMs) {
        holdUntil = nowMs + HOLD_MS;
        boolean changed = isMuted != muted;
        muted = isMuted;
        return changed;
    }
}
