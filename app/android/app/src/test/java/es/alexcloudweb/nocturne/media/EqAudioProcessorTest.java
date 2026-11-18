package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import org.junit.Test;

public class EqAudioProcessorTest {
    private static ByteBuffer pcm16(short[] samples) {
        ByteBuffer b = ByteBuffer.allocateDirect(samples.length * 2).order(ByteOrder.nativeOrder());
        for (short s : samples) b.putShort(s);
        b.flip();
        return b;
    }

    @Test
    public void convertsPcm16ToFloatUnchangedWhenFlat() throws Exception {
        EqAudioProcessor p = new EqAudioProcessor();
        AudioProcessor.AudioFormat out = p.configure(new AudioProcessor.AudioFormat(44100, 2, C.ENCODING_PCM_16BIT));
        assertEquals(C.ENCODING_PCM_FLOAT, out.encoding);
        assertEquals(44100, out.sampleRate);
        assertEquals(2, out.channelCount);
        assertTrue(p.isActive());
        p.flush();
        p.setState(new EqPrefs.State(true, 0, new double[10]));
        short[] in = {0, 1000, -1000, 32767, -32768, 12345};
        p.queueInput(pcm16(in));
        ByteBuffer o = p.getOutput().order(ByteOrder.nativeOrder());
        assertEquals(in.length * 4, o.remaining());
        for (short s : in) assertEquals(s / 32768f, o.getFloat(), 0f);
    }

    @Test
    public void appliesGainToFloatInput() throws Exception {
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
        float last = 0;
        while (o.hasRemaining()) last = o.getFloat();
        assertEquals(0.5 * Math.pow(10, -6 / 20.0), last, 1e-3);
    }

    @Test
    public void unknownEncodingsStayInactiveInsteadOfFailingPlayback() throws Exception {
        EqAudioProcessor p = new EqAudioProcessor();
        p.configure(new AudioProcessor.AudioFormat(48000, 2, C.ENCODING_PCM_8BIT));
        assertFalse(p.isActive());
    }
}
