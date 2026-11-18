package es.alexcloudweb.nocturne.media;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.util.UnstableApi;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Media3 {@link AudioProcessor} running the 10-band equalizer ({@link EqDsp}) on float PCM. It sits in the
 * {@code DefaultAudioSink} of the service's ExoPlayer, so it works with the app closed and in Android Auto.
 * 16/24/32-bit integer and float input are accepted; the output is always 32-bit float. Per-channel filter
 * state, coefficients recomputed on every sample-rate change, smoothed parameter ramps (see {@link EqDsp}).
 */
@OptIn(markerClass = UnstableApi.class)
public final class EqAudioProcessor extends BaseAudioProcessor {
    private static final int CHUNK_FRAMES = 256;

    private final EqDsp dsp = new EqDsp();
    private int encoding = C.ENCODING_INVALID;
    private int channels = 2;
    private float[] scratch = new float[CHUNK_FRAMES * 2];

    /** Thread-safe: callable from any thread while audio is playing. */
    public void setState(EqPrefs.State s) {
        dsp.setTarget(s == null ? EqDsp.Params.FLAT : new EqDsp.Params(s.enabled, s.preampDb, s.gains));
    }

    @Override
    protected AudioFormat onConfigure(AudioFormat input) throws UnhandledAudioFormatException {
        int enc = input.encoding;
        boolean ok = enc == C.ENCODING_PCM_16BIT || enc == C.ENCODING_PCM_24BIT || enc == C.ENCODING_PCM_32BIT || enc == C.ENCODING_PCM_FLOAT;
        if (!ok || input.channelCount < 1 || input.channelCount > 8) {
            // Unknown layouts are left alone (inactive) instead of failing playback.
            return AudioFormat.NOT_SET;
        }
        encoding = enc;
        channels = input.channelCount;
        scratch = new float[CHUNK_FRAMES * channels];
        dsp.configure(input.sampleRate, channels);
        return new AudioFormat(input.sampleRate, channels, C.ENCODING_PCM_FLOAT);
    }

    @Override
    public void queueInput(ByteBuffer in) {
        int bytesPer = encoding == C.ENCODING_PCM_16BIT ? 2 : encoding == C.ENCODING_PCM_24BIT ? 3 : 4;
        int frames = in.remaining() / (bytesPer * channels);
        if (frames == 0) {
            in.position(in.limit());
            return;
        }
        ByteBuffer out = replaceOutputBuffer(frames * channels * 4).order(ByteOrder.nativeOrder());
        ByteBuffer src = in.order(ByteOrder.nativeOrder());
        int done = 0;
        while (done < frames) {
            int n = Math.min(CHUNK_FRAMES, frames - done);
            int samples = n * channels;
            for (int i = 0; i < samples; i++) scratch[i] = readSample(src);
            dsp.process(scratch, 0, n);
            for (int i = 0; i < samples; i++) out.putFloat(scratch[i]);
            done += n;
        }
        in.position(in.limit()); // everything consumed (a trailing partial frame cannot occur)
        out.flip();
    }

    private float readSample(ByteBuffer b) {
        switch (encoding) {
            case C.ENCODING_PCM_16BIT:
                return b.getShort() * (1f / 32768f);
            case C.ENCODING_PCM_24BIT: {
                int v = (b.get() & 0xFF) | ((b.get() & 0xFF) << 8) | (b.get() << 16); // little endian, sign-extended
                return v * (1f / 8388608f);
            }
            case C.ENCODING_PCM_32BIT:
                return (float) (b.getInt() / 2147483648.0);
            default:
                return b.getFloat();
        }
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
