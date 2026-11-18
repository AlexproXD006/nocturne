package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LrcParserTest {
    private static final String LRC = "[ar:Someone]\n[00:01.50]Hello\n[00:05.00]World\n[00:09.5]\n[00:12.000][00:20.00]Again\n";

    @Test
    public void findsTheCurrentLine() {
        LrcParser p = LrcParser.parse(LRC, 0);
        assertEquals(-1, p.lineAt(1000));
        assertEquals("Hello", p.line(p.lineAt(1500)));
        assertEquals("Hello", p.line(p.lineAt(4999)));
        assertEquals("World", p.line(p.lineAt(5000)));
        assertEquals("", p.line(p.lineAt(10_000)));
        assertEquals("Again", p.line(p.lineAt(13_000)));
        assertEquals("Again", p.line(p.lineAt(99_000)));
        assertEquals(5, p.size());
    }

    @Test
    public void appliesTheServerOffset() {
        LrcParser p = LrcParser.parse(LRC, 500);
        assertEquals(-1, p.lineAt(1900));
        assertEquals("Hello", p.line(p.lineAt(2000)));
    }

    @Test
    public void ignoresGarbage() {
        assertTrue(LrcParser.parse("", 0).isEmpty());
        assertTrue(LrcParser.parse(null, 0).isEmpty());
        assertTrue(LrcParser.parse("just text\n[ti:x]", 0).isEmpty());
    }
}
