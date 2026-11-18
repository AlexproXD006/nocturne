package es.alexcloudweb.nocturne.media;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.util.UnstableApi;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Media3 {@link AudioProcessor} running the 10-band equalizer ({@link EqDsp}) inside the service's
 * {@code DefaultAudioSink}, so it works with the app closed and in Android Auto.
 *
 * <p>Conservative by design (a bad format negotiation breaks playback): it only handles 16-bit PCM and float
 * PCM and outputs <b>the same encoding it receives</b>; anything else makes it inactive (pure passthrough). It is
 * inactive too while the equalizer is disabled or flat, so users who do not use it get the stock audio pipeline.
 * Math is done in float internally; {@code queueInput} never throws (on any problem the input is copied through).
 */
@OptIn(markerClass = UnstableApi.class)
public final class EqAudioProcessor extends BaseAudioProcessor {
    private static final int CHUNK_FRAMES = 256;

    private final EqDsp dsp = new EqDsp();
    private volatile boolean wanted = false;
    private int encoding = C.ENCODING_INVALID;
    private int channels = 2;
    private float[] scratch = new float[CHUNK_FRAMES * 2];

    /** Thread-safe: callable from any thread while audio is playing. */
    public void setState(EqPrefs.State s) {
        EqDsp.Params p = s == null ? EqDsp.Params.FLAT : new EqDsp.Params(s.enabled, s.preampDb, s.gains);
        dsp.setTarget(p);
        wanted = p.enabled && (p.preampDb != 0 || anyGain(p.gains));
    }

    private static boolean anyGain(double[] g) {
        for (double v : g) if (v != 0) return true;
        return false;
    }

    @Override
    public boolean isActive() {
        // Still active while ramping back to flat so a disable does not click; it drops out at the next flush.
        return super.isActive() && (wanted || !dsp.isPassthrough());
    }

    @Override
    protected AudioFormat onConfigure(AudioFormat input) {
        int enc = input.encoding;
        if ((enc != C.ENCODING_PCM_16BIT && enc != C.ENCODING_PCM_FLOAT) || input.channelCount < 1 || input.channelCount > 8 || input.sampleRate <= 0) {
            return AudioFormat.NOT_SET; // unknown layout: leave the audio alone
        }
        encoding = enc;
        channels = input.channelCount;
        scratch = new float[CHUNK_FRAMES * channels];
        dsp.configure(input.sampleRate, channels);
        return input; // same encoding, rate and channels out as in
    }

    @Override
    public void queueInput(ByteBuffer in) {
        try {
            process(in);
        } catch (RuntimeException e) {
            // Never break playback: pass the bytes through untouched.
            in.rewind();
            ByteBuffer out = replaceOutputBuffer(in.remaining());
            out.put(in);
            out.flip();
        }
    }

    private void process(ByteBuffer in) {
        final boolean is16 = encoding == C.ENCODING_PCM_16BIT;
        final int bytesPer = is16 ? 2 : 4;
        final int frameBytes = bytesPer * channels;
        final int frames = in.remaining() / frameBytes;
        final int total = in.remaining();
        ByteBuffer out = replaceOutputBuffer(total).order(ByteOrder.nativeOrder());
        ByteBuffer src = in.order(ByteOrder.nativeOrder());
        int done = 0;
        while (done < frames) {
            int n = Math.min(CHUNK_FRAMES, frames - done);
            int samples = n * channels;
            for (int i = 0; i < samples; i++) scratch[i] = is16 ? src.getShort() * (1f / 32768f) : src.getFloat();
            dsp.process(scratch, 0, n);
            for (int i = 0; i < samples; i++) {
                float v = scratch[i];
                if (is16) {
                    int q = Math.round(v * 32768f);
                    out.putShort((short) (q > 32767 ? 32767 : (q < -32768 ? -32768 : q)));
                } else {
                    out.putFloat(v);
                }
            }
            done += n;
        }
        while (src.hasRemaining()) out.put(src.get()); // trailing partial frame, if any
        out.flip();
    }

    @Override
    protected void onFlush() {
        dsp.resetState();
    }

    @Override
    protected void onReset() {
        dsp.resetState();
        encoding = C.ENCODING_INVALID;
    }
}
