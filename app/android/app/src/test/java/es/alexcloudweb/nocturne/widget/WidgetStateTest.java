package es.alexcloudweb.nocturne.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class WidgetStateTest {
    @Test
    public void progressIsScaledAndClamped() {
        WidgetState s = new WidgetState.Builder().position(50_000, 200_000).build();
        assertEquals(250, s.progress(1000));
        assertEquals(0, new WidgetState.Builder().position(5_000, 0).build().progress(1000));
        assertEquals(1000, new WidgetState.Builder().position(999_000, 200_000).build().progress(1000));
    }

    @Test
    public void keepsAtMostThreeUpNextLines() {
        WidgetState.Builder b = new WidgetState.Builder();
        for (int i = 0; i < 6; i++) b.next("T" + i, "A");
        WidgetState s = b.build();
        assertEquals(3, s.upNext.size());
        assertEquals("T0 · A", s.upNext.get(0));
        assertEquals("T2", new WidgetState.Builder().next("T2", "").build().upNext.get(0));
    }

    @Test
    public void withProgressAndLikedCopy() {
        WidgetState s = new WidgetState.Builder().queue(true).track("t1", "Song", "Artist", "http://x").playing(true).build();
        WidgetState p = s.withProgress(7_000, 100_000, "la la");
        assertEquals("la la", p.lyric);
        assertEquals(7_000, p.positionMs);
        assertEquals("Song", p.title);
        assertTrue(p.playing);
        assertTrue(s.withLiked(true).liked);
        assertFalse(s.liked);
    }

    @Test
    public void emptyStateHasNoQueue() {
        assertFalse(WidgetState.EMPTY.hasQueue);
        assertEquals("", WidgetState.EMPTY.title);
    }

    @Test
    public void coverSampleSizeKeepsAtLeastTheTargetSize() {
        assertEquals(1, CoverLoader.sampleSize(500, 500, 512));
        assertEquals(1, CoverLoader.sampleSize(1000, 1000, 512));
        assertEquals(2, CoverLoader.sampleSize(1024, 1024, 512));
        assertEquals(4, CoverLoader.sampleSize(3000, 3000, 512));
        assertEquals(1, CoverLoader.sampleSize(4000, 600, 512));
    }
}
