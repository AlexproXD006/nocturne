package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public class EqDspTest {
    private static final double SR = 48000;

    private static double[] gainsAt(int band, double db) {
        double[] g = new double[EqDsp.BANDS];
        g[band] = db;
        return g;
    }

    @Test
    public void peakingBandHasExactGainAtItsCentre() {
        for (int b = 1; b < EqDsp.BANDS - 1; b++) {
            for (double db : new double[] {-12, -6, 3, 6, 12}) {
                double[] c = EqDsp.coefficients(b, db, SR);
                assertEquals("band " + b + " @ " + db, db, EqDsp.magnitudeDb(c, EqDsp.FREQS[b], SR), 0.05);
            }
        }
    }

    @Test
    public void peakingBandIsNearlyFlatFarAway() {
        double[] c = EqDsp.coefficients(5, 12, SR); // 1 kHz +12 dB
        assertEquals(0, EqDsp.magnitudeDb(c, 31, SR), 0.35);
        assertEquals(0, EqDsp.magnitudeDb(c, 16000, SR), 0.35);
        assertTrue(EqDsp.magnitudeDb(c, 1000, SR) > 11.9);
    }

    @Test
    public void shelvesReachFullGainTowardTheEdgesAndHalfAtTheCorner() {
        double[] low = EqDsp.coefficients(0, 9, SR);
        assertEquals(4.5, EqDsp.magnitudeDb(low, 31, SR), 0.15); // shelf midpoint = half gain
        assertEquals(7.5, EqDsp.magnitudeDb(low, 20, SR), 0.3); // approaching the full +9 dB below the corner
        assertEquals(0, EqDsp.magnitudeDb(low, 2000, SR), 0.2);
        double[] high = EqDsp.coefficients(9, -8, SR);
        assertEquals(-4, EqDsp.magnitudeDb(high, 16000, SR), 0.3);
        assertEquals(-7.6, EqDsp.magnitudeDb(high, 20000, SR), 0.3);
        assertEquals(0, EqDsp.magnitudeDb(high, 500, SR), 0.2);
    }

    @Test
    public void zeroGainIsAnIdentityFilter() {
        for (int b = 0; b < EqDsp.BANDS; b++) {
            double[] c = EqDsp.coefficients(b, 0, 44100);
            for (double f : new double[] {40, 300, 1000, 5000, 15000}) assertEquals(0, EqDsp.magnitudeDb(c, f, 44100), 1e-9);
        }
    }

    @Test
    public void coefficientsFollowTheSampleRate() {
        // The same +6 dB at 1 kHz must hold at other sample rates (coefficients are recomputed per rate).
        for (double sr : new double[] {22050, 32000, 44100, 48000, 96000}) {
            assertEquals(6, EqDsp.magnitudeDb(EqDsp.coefficients(5, 6, sr), 1000, sr), 0.05);
        }
    }

    @Test
    public void combinedResponseSumsTheBands() {
        double[] g = new double[EqDsp.BANDS];
        g[3] = 4;
        g[6] = -5;
        assertEquals(4, EqDsp.responseDb(g, 250, SR), 0.4);
        assertEquals(-5, EqDsp.responseDb(g, 2000, SR), 0.4);
    }

    private static float[] sine(double freq, int frames, int channels, double amp) {
        float[] b = new float[frames * channels];
        for (int i = 0; i < frames; i++) for (int c = 0; c < channels; c++) b[i * channels + c] = (float) (amp * Math.sin(2 * Math.PI * freq * i / SR));
        return b;
    }

    private static double rms(float[] b, int fromFrame, int toFrame, int channels, int ch) {
        double s = 0;
        int n = 0;
        for (int i = fromFrame; i < toFrame; i++) {
            double v = b[i * channels + ch];
            s += v * v;
            n++;
        }
        return Math.sqrt(s / n);
    }

    @Test
    public void flatSettingsArePassthrough() {
        EqDsp dsp = new EqDsp();
        dsp.configure(48000, 2);
        dsp.setTarget(new EqDsp.Params(true, 0, new double[EqDsp.BANDS]));
        float[] in = sine(440, 4800, 2, 0.5);
        float[] out = in.clone();
        dsp.process(out, 0, 4800);
        assertTrue(dsp.isPassthrough());
        for (int i = 0; i < in.length; i++) assertEquals(in[i], out[i], 0f);
    }

    @Test
    public void disabledIsPassthroughEvenWithGains() {
        EqDsp dsp = new EqDsp();
        dsp.configure(48000, 2);
        dsp.setTarget(new EqDsp.Params(false, -6, gainsAt(5, 12)));
        float[] in = sine(1000, 4800, 2, 0.5);
        float[] out = in.clone();
        dsp.process(out, 0, 4800);
        for (int i = 0; i < in.length; i++) assertEquals(in[i], out[i], 0f);
    }

    @Test
    public void boostedBandAmplifiesASineByTheConfiguredGainAfterTheRamp() {
        EqDsp dsp = new EqDsp();
        dsp.configure(48000, 2);
        dsp.setTarget(new EqDsp.Params(true, 0, gainsAt(5, 6)));
        int frames = 48000;
        float[] buf = sine(1000, frames, 2, 0.1);
        float[] ref = buf.clone();
        dsp.process(buf, 0, frames);
        double gainDb = 20 * Math.log10(rms(buf, 40000, frames, 2, 0) / rms(ref, 40000, frames, 2, 0));
        assertEquals(6, gainDb, 0.2);
        // both channels are processed independently and identically
        assertEquals(rms(buf, 40000, frames, 2, 0), rms(buf, 40000, frames, 2, 1), 1e-6);
    }

    @Test
    public void preampScalesTheSignal() {
        EqDsp dsp = new EqDsp();
        dsp.configure(48000, 1);
        dsp.setTarget(new EqDsp.Params(true, -6, null));
        float[] buf = sine(200, 48000, 1, 0.5);
        float[] ref = buf.clone();
        dsp.process(buf, 0, 48000);
        assertEquals(-6, 20 * Math.log10(rms(buf, 40000, 48000, 1, 0) / rms(ref, 40000, 48000, 1, 0)), 0.1);
    }

    @Test
    public void rampsAreSmoothAndClickFree() {
        EqDsp dsp = new EqDsp();
        dsp.configure(48000, 1);
        dsp.setTarget(new EqDsp.Params(true, 0, new double[EqDsp.BANDS]));
        float[] warm = sine(1000, 4800, 1, 0.3);
        dsp.process(warm, 0, 4800);
        dsp.setTarget(new EqDsp.Params(true, 0, gainsAt(5, 12))); // sudden +12 dB
        float[] buf = sine(1000, 9600, 1, 0.3);
        dsp.process(buf, 0, 9600);
        // The largest sample-to-sample step must stay near that of the final (4x amplitude) sine: no discontinuity.
        double maxStep = 0;
        for (int i = 1; i < buf.length; i++) maxStep = Math.max(maxStep, Math.abs(buf[i] - buf[i - 1]));
        double sineStep = 4 * 0.3 * 2 * Math.PI * 1000 / SR;
        assertTrue("click detected: " + maxStep, maxStep < sineStep * 1.15);
    }

    @Test
    public void reconfigureKeepsWorkingAtANewSampleRate() {
        EqDsp dsp = new EqDsp();
        dsp.setTarget(new EqDsp.Params(true, 0, gainsAt(5, 6)));
        dsp.configure(44100, 2);
        dsp.process(new float[2 * 44100], 0, 44100);
        dsp.configure(96000, 2);
        float[] buf = new float[2 * 96000];
        for (int i = 0; i < 96000; i++) buf[2 * i] = buf[2 * i + 1] = (float) (0.1 * Math.sin(2 * Math.PI * 1000 * i / 96000.0));
        float[] ref = buf.clone();
        dsp.process(buf, 0, 96000);
        assertEquals(6, 20 * Math.log10(rms(buf, 80000, 96000, 2, 0) / rms(ref, 80000, 96000, 2, 0)), 0.2);
    }

    @Test
    public void paramsAreClamped() {
        EqDsp.Params p = new EqDsp.Params(true, 40, new double[] {99, -99, Double.NaN});
        assertEquals(6, p.preampDb, 0);
        assertEquals(12, p.gains[0], 0);
        assertEquals(-12, p.gains[1], 0);
        assertEquals(0, p.gains[2], 0);
        assertEquals(0, p.gains[9], 0);
        assertEquals(-12, new EqDsp.Params(true, -99, null).preampDb, 0);
    }

    @Test
    public void prefsRoundTripAndSanitise() throws Exception {
        EqPrefs.State s = new EqPrefs.State(true, -3, new double[] {1, 2, 3, 4, 5, 6, 7, 8, 9, 10});
        EqPrefs.State back = EqPrefs.parse(s.toJson().toString());
        assertTrue(back.enabled);
        assertEquals(-3, back.preampDb, 0);
        assertEquals(10, back.gains[9], 0);
        assertFalse(EqPrefs.parse(null).enabled);
        assertFalse(EqPrefs.parse("not json").enabled);
        EqPrefs.State odd = EqPrefs.State.fromJson(new JSONObject("{\"enabled\":true,\"preamp\":99,\"gains\":[50,-50]}"));
        assertEquals(6, odd.preampDb, 0);
        assertEquals(12, odd.gains[0], 0);
        assertEquals(-12, odd.gains[1], 0);
        assertEquals(0, odd.gains[2], 0);
    }
}
