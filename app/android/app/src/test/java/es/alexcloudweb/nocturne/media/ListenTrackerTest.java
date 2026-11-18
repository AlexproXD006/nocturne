package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class ListenTrackerTest {
    private static void play(ListenTracker t, long fromMs, long toMs) {
        for (long p = fromMs; p <= toMs; p += 1000) t.tick(p, true);
    }

    @Test
    public void thirtySecondsCountAsAPlay() {
        ListenTracker t = new ListenTracker();
        t.start("a", 300_000, 1000);
        play(t, 0, 31_000);
        ListenTracker.Listen l = t.finish();
        assertNotNull(l);
        assertEquals("a", l.trackId);
        assertEquals(31, l.seconds);
        assertNull(t.finish());
    }

    @Test
    public void halfOfAShortTrackCounts() {
        ListenTracker t = new ListenTracker();
        t.start("a", 20_000, 0);
        play(t, 0, 10_000);
        assertNotNull(t.finish());
    }

    @Test
    public void skippingEarlyDoesNotCount() {
        ListenTracker t = new ListenTracker();
        t.start("a", 200_000, 0);
        play(t, 0, 8000);
        assertNull(t.finish());
    }

    @Test
    public void seeksAndPausesAreNotListening() {
        ListenTracker t = new ListenTracker();
        t.start("a", 600_000, 0);
        play(t, 0, 5000);
        t.tick(100_000, true); // seek forward
        play(t, 101_000, 105_000);
        t.tick(106_000, false); // paused
        t.tick(107_000, false);
        assertEquals(10, t.listenedSeconds());
    }
}
