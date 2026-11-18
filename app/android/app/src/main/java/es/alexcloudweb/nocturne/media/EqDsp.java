package es.alexcloudweb.nocturne.media;

/**
 * Equalizer DSP core: 10 cascaded biquads (RBJ cookbook) on interleaved float samples. No Android classes,
 * so it is unit-tested on the JVM ({@code EqDspTest}) and the maths match {@code lib/eq.ts} in the WebView.
 *
 * <p>Band 0 is a low shelf, band 9 a high shelf, the rest are peaking filters with Q = 1. Gain changes are
 * smoothed: every {@link #BLOCK} frames the current gains (dB) move toward the targets with a ~20 ms time
 * constant, so dragging a band on a phone never clicks. All-flat settings take a bit-exact passthrough path.
 */
final class EqDsp {
    static final int BANDS = 10;
    static final double[] FREQS = {31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000};
    static final double Q = 1.0;
    static final double GAIN_MIN = -12, GAIN_MAX = 12, PREAMP_MIN = -12, PREAMP_MAX = 6;
    /** Frames per coefficient update / ramp step. */
    static final int BLOCK = 32;
    private static final double RAMP_SECONDS = 0.02;

    /** Immutable target settings (swapped atomically between the UI and the audio thread). */
    static final class Params {
        final boolean enabled;
        final double preampDb;
        final double[] gains;

        Params(boolean enabled, double preampDb, double[] gains) {
            this.enabled = enabled;
            this.preampDb = clamp(preampDb, PREAMP_MIN, PREAMP_MAX);
            double[] g = new double[BANDS];
            for (int i = 0; i < BANDS; i++) g[i] = gains != null && i < gains.length ? clamp(gains[i], GAIN_MIN, GAIN_MAX) : 0;
            this.gains = g;
        }

        static final Params FLAT = new Params(false, 0, null);
    }

    static double clamp(double v, double lo, double hi) {
        if (Double.isNaN(v)) return 0;
        return Math.max(lo, Math.min(hi, v));
    }

    /** Normalised coefficients {b0, b1, b2, a1, a2} (a0 = 1) for band {@code band}. */
    static double[] coefficients(int band, double gainDb, double sampleRate) {
        double f0 = Math.min(FREQS[band], sampleRate * 0.45);
        double A = Math.pow(10, gainDb / 40);
        double w0 = 2 * Math.PI * f0 / sampleRate;
        double cos = Math.cos(w0), sin = Math.sin(w0);
        double b0, b1, b2, a0, a1, a2;
        if (band == 0 || band == BANDS - 1) {
            double alpha = sin / 2 * Math.sqrt(2); // shelf slope S = 1
            double k = 2 * Math.sqrt(A) * alpha;
            if (band == 0) { // low shelf
                b0 = A * (A + 1 - (A - 1) * cos + k);
                b1 = 2 * A * (A - 1 - (A + 1) * cos);
                b2 = A * (A + 1 - (A - 1) * cos - k);
                a0 = A + 1 + (A - 1) * cos + k;
                a1 = -2 * (A - 1 + (A + 1) * cos);
                a2 = A + 1 + (A - 1) * cos - k;
            } else { // high shelf
                b0 = A * (A + 1 + (A - 1) * cos + k);
                b1 = -2 * A * (A - 1 + (A + 1) * cos);
                b2 = A * (A + 1 + (A - 1) * cos - k);
                a0 = A + 1 - (A - 1) * cos + k;
                a1 = 2 * (A - 1 - (A + 1) * cos);
                a2 = A + 1 - (A - 1) * cos - k;
            }
        } else { // peaking
            double alpha = sin / (2 * Q);
            b0 = 1 + alpha * A;
            b1 = -2 * cos;
            b2 = 1 - alpha * A;
            a0 = 1 + alpha / A;
            a1 = -2 * cos;
            a2 = 1 - alpha / A;
        }
        return new double[] {b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
    }

    /** Magnitude of a biquad at {@code freq}, in dB. */
    static double magnitudeDb(double[] c, double freq, double sampleRate) {
        double w = 2 * Math.PI * freq / sampleRate;
        double cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
        double nr = c[0] + c[1] * cw + c[2] * c2, ni = -(c[1] * sw + c[2] * s2);
        double dr = 1 + c[3] * cw + c[4] * c2, di = -(c[3] * sw + c[4] * s2);
        return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
    }

    /** Combined response of the whole cascade (preamp excluded) at {@code freq}, in dB. */
    static double responseDb(double[] gains, double freq, double sampleRate) {
        double db = 0;
        for (int i = 0; i < BANDS; i++) if (gains[i] != 0) db += magnitudeDb(coefficients(i, gains[i], sampleRate), freq, sampleRate);
        return db;
    }

    // ---- stream state ---------------------------------------------------------------------------------

    private volatile Params target = Params.FLAT;
    private int channels = 2;
    private double sampleRate = 44100;
    private double[][] z1 = new double[2][BANDS];
    private double[][] z2 = new double[2][BANDS];
    private final double[] curGain = new double[BANDS];
    private double curPreampDb = 0;
    private final double[][] coef = new double[BANDS][5];
    private final boolean[] active = new boolean[BANDS];
    private double preampLinear = 1;
    private boolean anyActive = false;
    private double rampAlpha = 0.1;

    void setTarget(Params p) {
        target = p == null ? Params.FLAT : p;
    }

    Params target() {
        return target;
    }

    /** Prepares for a stream; filter memories are cleared. Current (ramped) gains are kept, so a track change does not re-ramp. */
    void configure(int sampleRate, int channels) {
        this.sampleRate = sampleRate;
        this.channels = Math.max(1, channels);
        this.z1 = new double[this.channels][BANDS];
        this.z2 = new double[this.channels][BANDS];
        this.rampAlpha = 1 - Math.exp(-BLOCK / (sampleRate * RAMP_SECONDS));
        recompute();
    }

    /** Clears the filter memories (seek / flush) so no ringing from the previous position is heard. */
    void resetState() {
        for (double[] a : z1) java.util.Arrays.fill(a, 0);
        for (double[] a : z2) java.util.Arrays.fill(a, 0);
    }

    /** True when the output equals the input bit for bit (all bands flat and the preamp at 0 dB right now). */
    boolean isPassthrough() {
        return !anyActive && curPreampDb == 0;
    }

    /** Moves the current gains toward the target; returns true while a ramp is in progress. */
    private boolean ramp() {
        Params t = target;
        boolean moving = false;
        boolean changed = false;
        for (int i = 0; i < BANDS; i++) {
            double goal = t.enabled ? t.gains[i] : 0;
            if (curGain[i] != goal) {
                double next = curGain[i] + (goal - curGain[i]) * rampAlpha;
                if (Math.abs(goal - next) < 0.005) next = goal;
                curGain[i] = next;
                changed = true;
                if (next != goal) moving = true;
            }
        }
        double goalPre = t.enabled ? t.preampDb : 0;
        if (curPreampDb != goalPre) {
            double next = curPreampDb + (goalPre - curPreampDb) * rampAlpha;
            if (Math.abs(goalPre - next) < 0.005) next = goalPre;
            curPreampDb = next;
            preampLinear = Math.pow(10, next / 20);
            changed = true;
            if (next != goalPre) moving = true;
        }
        if (changed) recompute();
        return moving;
    }

    private void recompute() {
        anyActive = false;
        for (int i = 0; i < BANDS; i++) {
            boolean on = curGain[i] != 0;
            if (on && !active[i]) {
                for (int c = 0; c < channels; c++) z1[c][i] = z2[c][i] = 0; // fresh memory for a band switching on
            }
            active[i] = on;
            if (on) {
                coef[i] = coefficients(i, curGain[i], sampleRate);
                anyActive = true;
            }
        }
        preampLinear = Math.pow(10, curPreampDb / 20);
    }

    /** Processes {@code frames} interleaved frames in place starting at {@code off}. */
    void process(float[] buf, int off, int frames) {
        int pos = off;
        int left = frames;
        while (left > 0) {
            ramp();
            int n = Math.min(BLOCK, left);
            if (anyActive || curPreampDb != 0) filterBlock(buf, pos, n);
            pos += n * channels;
            left -= n;
        }
    }

    private void filterBlock(float[] buf, int pos, int frames) {
        final int ch = channels;
        for (int f = 0; f < frames; f++) {
            for (int c = 0; c < ch; c++) {
                double x = buf[pos + f * ch + c];
                final double[] s1 = z1[c], s2 = z2[c];
                for (int b = 0; b < BANDS; b++) {
                    if (!active[b]) continue;
                    final double[] k = coef[b];
                    double y = k[0] * x + s1[b];
                    s1[b] = k[1] * x - k[3] * y + s2[b];
                    s2[b] = k[2] * x - k[4] * y;
                    x = y;
                }
                buf[pos + f * ch + c] = (float) (x * preampLinear);
            }
        }
    }
}
