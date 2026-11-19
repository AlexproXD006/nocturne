package es.alexcloudweb.nocturne.diag;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.file.Files;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class DiagTest {
    @Test
    public void scrubRemovesQueriesAndTokens() {
        String s = DiagScrub.scrub("GET https://x.example/a/b?token=abc&X-Amz-Signature=zzz failed; Authorization: Bearer abcdefgh12345 eyJhbGciOi.eyJzdWIiOiIxIn0.sig12345");
        assertFalse(s, s.contains("abc&"));
        assertFalse(s, s.contains("zzz"));
        assertFalse(s, s.contains("abcdefgh12345"));
        assertFalse(s, s.contains("eyJzdWIi"));
        assertTrue(s, s.contains("https://x.example/a/b?<redacted>"));
    }

    @Test
    public void scrubCapsLength() {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 100_000; i++) b.append('x');
        assertTrue(DiagScrub.scrub(b.toString()).length() < DiagScrub.MAX_CHARS + 50);
    }

    @Test
    public void crashStoreRoundTripAndPrune() throws Exception {
        File dir = Files.createTempDirectory("crash").toFile();
        CrashStore store = new CrashStore(dir);
        for (int i = 0; i < CrashStore.MAX_FILES + 3; i++) {
            assertTrue(store.write(CrashStore.report("native", "1.0", "Android 14", "Samsung X", i, "boom " + i + " https://a/b?sig=1")));
            Thread.sleep(2);
        }
        List<JSONObject> l = store.list();
        assertEquals(CrashStore.MAX_FILES, l.size());
        assertFalse(l.get(0).getString("trace").contains("sig=1"));
        assertEquals("Samsung X", l.get(0).getString("device"));
        store.clear();
        assertEquals(0, store.list().size());
    }

    @Test
    public void stackOfIncludesCause() {
        String s = CrashStore.stackOf(new RuntimeException("outer", new IllegalStateException("inner")));
        assertTrue(s.contains("outer") && s.contains("inner"));
    }

    @Test
    public void ringLogKeepsLastLinesAndSurvivesRestart() throws Exception {
        File f = new File(Files.createTempDirectory("ring").toFile(), "log.txt");
        RingLog r = new RingLog(f, 10);
        for (int i = 0; i < 25; i++) r.add("line " + i + " token=secret" + i);
        String snap = r.snapshot();
        assertEquals(10, snap.split("\n").length);
        assertTrue(snap.endsWith("token=<redacted>"));
        assertFalse(snap.contains("secret"));
        String again = new RingLog(f, 10).snapshot();
        assertTrue(again.contains("line 24"));
    }
}
