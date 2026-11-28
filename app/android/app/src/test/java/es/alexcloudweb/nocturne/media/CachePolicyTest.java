package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.Test;

public class CachePolicyTest {
    private static List<CachePolicy.Entry> tracks(int n, long bytesEach) {
        List<CachePolicy.Entry> l = new ArrayList<>();
        // t0 is the oldest, t(n-1) the most recently played.
        for (int i = 0; i < n; i++) l.add(new CachePolicy.Entry("t" + i, bytesEach, 1000 + i));
        return l;
    }

    private static Set<String> set(String... s) {
        return new HashSet<>(Arrays.asList(s));
    }

    @Test
    public void defaultsToThirtyTracks() {
        assertEquals(30, CachePolicy.DEFAULT_TRACKS);
        assertEquals(30, CachePolicy.tracks(30).maxTracks);
    }

    @Test
    public void keepsTheMostRecentNAndEvictsTheOldest() {
        List<String> v = CachePolicy.tracks(30).victims(tracks(33, 10), Collections.<String>emptySet(), Collections.<String>emptySet());
        assertEquals(Arrays.asList("t2", "t1", "t0"), v);
    }

    @Test
    public void nothingToEvictWithinBudget() {
        assertTrue(CachePolicy.tracks(50).victims(tracks(50, 10), Collections.<String>emptySet(), Collections.<String>emptySet()).isEmpty());
    }

    @Test
    public void pinnedTracksAreNeverEvictedAndDoNotCountTowardsTheRotation() {
        // 32 tracks, t0 and t1 are downloads: the 30 others fit exactly, so nothing is evicted.
        List<String> v = CachePolicy.tracks(30).victims(tracks(32, 10), set("t0", "t1"), Collections.<String>emptySet());
        assertTrue(v.isEmpty());
        // 33 tracks with the same two pinned: only the oldest unpinned one goes.
        v = CachePolicy.tracks(30).victims(tracks(33, 10), set("t0", "t1"), Collections.<String>emptySet());
        assertEquals(Collections.singletonList("t2"), v);
    }

    @Test
    public void protectedKeyIsKeptEvenWhenOld() {
        List<String> v = CachePolicy.tracks(30).victims(tracks(31, 10), Collections.<String>emptySet(), set("t0"));
        // t0 is protected, so the next oldest one is dropped instead.
        assertEquals(Collections.singletonList("t1"), v);
    }

    @Test
    public void invalidSizesFallBackToTheDefaults() {
        assertEquals(30, CachePolicy.sanitizeTracks(7));
        assertEquals(200, CachePolicy.sanitizeTracks(200));
        assertEquals(0, CachePolicy.sanitizeBytes(123));
        assertEquals(2 * CachePolicy.GB, CachePolicy.sanitizeBytes(2 * CachePolicy.GB));
    }

    @Test
    public void sizeModeKeepsAsManyRecentTracksAsFit() {
        CachePolicy p = CachePolicy.bytes(CachePolicy.GB);
        long mb300 = 300L * 1024 * 1024;
        // 5 tracks of 300 MB: 3 fit in 1 GB (900 MB), the two oldest go.
        List<String> v = p.victims(tracks(5, mb300), Collections.<String>emptySet(), Collections.<String>emptySet());
        assertEquals(Arrays.asList("t1", "t0"), v);
    }

    @Test
    public void sizeModeAlwaysKeepsTheMostRecentEvenIfItAloneIsTooBig() {
        CachePolicy p = CachePolicy.bytes(CachePolicy.GB);
        List<CachePolicy.Entry> l = new ArrayList<>();
        l.add(new CachePolicy.Entry("old", 10, 1));
        l.add(new CachePolicy.Entry("huge", 2 * CachePolicy.GB, 2));
        assertEquals(Collections.singletonList("old"), p.victims(l, Collections.<String>emptySet(), Collections.<String>emptySet()));
    }

    @Test
    public void sizeModeIgnoresPinnedBytes() {
        CachePolicy p = CachePolicy.bytes(CachePolicy.GB);
        List<CachePolicy.Entry> l = new ArrayList<>();
        l.add(new CachePolicy.Entry("download", 4 * CachePolicy.GB, 1));
        l.add(new CachePolicy.Entry("a", 400L * 1024 * 1024, 2));
        l.add(new CachePolicy.Entry("b", 400L * 1024 * 1024, 3));
        assertTrue(p.victims(l, set("download"), Collections.<String>emptySet()).isEmpty());
    }
}
