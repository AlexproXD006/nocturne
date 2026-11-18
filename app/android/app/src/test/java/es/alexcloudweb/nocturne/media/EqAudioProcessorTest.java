package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import org.junit.Test;

public class EqAudioProcessorTest {
    private static final double[] BOOST = {0, 0, 0, 0, 0, 6, 0, 0, 0, 0};

    private static ByteBuffer pcm16(short[] samples) {
        ByteBuffer b = ByteBuffer.allocateDirect(samples.length * 2).order(ByteOrder.nativeOrder());
        for (short s : samples) b.putShort(s);
        b.flip();
        return b;
    }

    private static byte[] bytes(ByteBuffer b) {
        byte[] a = new byte[b.remaining()];
        b.get(a);
        return a;
    }

    private static short[] sine16(int frames, int ch, double sr, double amp) {
        short[] s = new short[frames * ch];
        for (int i = 0; i < frames; i++) for (int c = 0; c < ch; c++) s[i * ch + c] = (short) (amp * 32767 * Math.sin(2 * Math.PI * 1000 * i / sr));
        return s;
    }

    @Test
    public void keepsTheInputFormatNeverChangesTheEncoding() throws Exception {
        for (int enc : new int[] {C.ENCODING_PCM_16BIT, C.ENCODING_PCM_FLOAT}) {
            for (int rate : new int[] {44100, 48000, 96000}) {
                for (int ch : new int[] {1, 2, 6}) {
                    EqAudioProcessor p = new EqAudioProcessor();
                    p.setState(new EqPrefs.State(true, -3, BOOST));
                    AudioProcessor.AudioFormat in = new AudioProcessor.AudioFormat(rate, ch, enc);
                    AudioProcessor.AudioFormat out = p.configure(in);
                    assertEquals(in, out);
                    assertTrue(p.isActive());
                }
            }
        }
    }

    @Test
    public void disabledOrFlatIsInactiveSoThePipelineIsStock() throws Exception {
        EqAudioProcessor p = new EqAudioProcessor();
        p.configure(new AudioProcessor.AudioFormat(44100, 2, C.ENCODING_PCM_16BIT));
        assertFalse(p.isActive()); // default state
        p.setState(new EqPrefs.State(false, -3, BOOST));
        assertFalse(p.isActive());
        p.setState(new EqPrefs.State(true, 0, new double[10]));
        assertFalse(p.isActive());
        p.setState(new EqPrefs.State(true, 0, BOOST));
        assertTrue(p.isActive());
    }

    @Test
    public void disabledPassthroughIsByteIdentical16Bit() throws Exception {
        EqAudioProcessor p = new EqAudioProcessor();
        p.configure(new AudioProcessor.AudioFormat(44100, 2, C.ENCODING_PCM_16BIT));
        p.flush();
        short[] in = sine16(1000, 2, 44100, 0.7);
        in[0] = 32767;
        in[1] = -32768;
        p.queueInput(pcm16(in));
        assertArrayEquals(bytes(pcm16(in)), bytes(p.getOutput()));
    }

    @Test
    public void flatEnabledStatePassthroughIsByteIdenticalEvenWhenQueued() throws Exception {
        EqAudioProcessor p = new EqAudioProcessor();
        p.setState(new EqPrefs.State(true, 0, new double[10]));
        p.configure(new AudioProcessor.AudioFormat(48000, 2, C.ENCODING_PCM_16BIT));
        p.flush();
        short[] in = sine16(500, 2, 48000, 0.5);
        p.queueInput(pcm16(in));
        assertArrayEquals(bytes(pcm16(in)), bytes(p.getOutput()));
    }

    @Test
    public void enabled16BitStereo44kProducesBoundedSameSizedOutput() throws Exception {
        EqAudioProcessor p = new EqAudioProcessor();
        p.setState(new EqPrefs.State(true, 0, new double[] {12, 12, 12, 12, 12, 12, 12, 12, 12, 12}));
        p.configure(new AudioProcessor.AudioFormat(44100, 2, C.ENCODING_PCM_16BIT));
        p.flush();
        short[] in = sine16(44100, 2, 44100, 0.95); // would clip badly: output must saturate, not wrap
        ByteBuffer src = pcm16(in);
        p.queueInput(src);
        assertFalse(src.hasRemaining());
        ByteBuffer o = p.getOutput().order(ByteOrder.nativeOrder());
        assertEquals(in.length * 2, o.remaining());
        int peak = 0;
        while (o.hasRemaining()) peak = Math.max(peak, Math.abs((int) o.getShort()));
        assertTrue(peak > 30000);
    }

    @Test
    public void enabledFloat48kBoostsByTheRequestedGain() throws Exception {
        EqAudioProcessor p = new EqAudioProcessor();
        p.setState(new EqPrefs.State(true, -6, new double[10]));
        p.configure(new AudioProcessor.AudioFormat(48000, 1, C.ENCODING_PCM_FLOAT));
        p.flush();
        int frames = 48000;
        ByteBuffer in = ByteBuffer.allocateDirect(frames * 4).order(ByteOrder.nativeOrder());
        for (int i = 0; i < frames; i++) in.putFloat(0.5f);
        in.flip();
        p.queueInput(in);
        ByteBuffer o = p.getOutput().order(ByteOrder.nativeOrder());
        assertEquals(frames * 4, o.remaining());
        float last = 0;
        while (o.hasRemaining()) last = o.getFloat();
        assertEquals(0.5 * Math.pow(10, -6 / 20.0), last, 1e-3);
    }

    @Test
    public void unsupportedFormatsStayInactiveAndNeverThrow() throws Exception {
        for (int enc : new int[] {C.ENCODING_PCM_8BIT, C.ENCODING_PCM_24BIT, C.ENCODING_PCM_32BIT}) {
            EqAudioProcessor p = new EqAudioProcessor();
            p.setState(new EqPrefs.State(true, 0, BOOST));
            p.configure(new AudioProcessor.AudioFormat(48000, 2, enc));
            assertFalse(p.isActive());
        }
        EqAudioProcessor p = new EqAudioProcessor();
        p.setState(new EqPrefs.State(true, 0, BOOST));
        p.configure(new AudioProcessor.AudioFormat(48000, 9, C.ENCODING_PCM_16BIT));
        assertFalse(p.isActive());
    }
}
