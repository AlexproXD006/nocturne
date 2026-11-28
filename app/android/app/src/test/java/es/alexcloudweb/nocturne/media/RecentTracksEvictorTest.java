package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.datasource.cache.Cache;
import androidx.media3.datasource.cache.CacheSpan;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.NavigableSet;
import java.util.Set;
import java.util.TreeSet;
import org.junit.Test;

/** The Media3 evictor driving {@link CachePolicy}: a fake Cache records which spans get removed. */
public class RecentTracksEvictorTest {
    /** A Cache whose only working methods are getCachedSpans / removeSpan. */
    private static final class FakeCache {
        final Map<String, List<CacheSpan>> spans = new HashMap<>();
        final List<String> removedKeys = new ArrayList<>();
        RecentTracksEvictor evictor;
        final Cache cache = (Cache) Proxy.newProxyInstance(Cache.class.getClassLoader(), new Class<?>[] {Cache.class}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "getCachedSpans": {
                    NavigableSet<CacheSpan> set = new TreeSet<>();
                    List<CacheSpan> l = spans.get((String) args[0]);
                    if (l != null) set.addAll(l);
                    return set;
                }
                case "removeSpan": {
                    CacheSpan s = (CacheSpan) args[0];
                    List<CacheSpan> l = spans.get(s.key);
                    if (l != null) l.remove(s);
                    if (l != null && l.isEmpty()) spans.remove(s.key);
                    removedKeys.add(s.key);
                    evictor.onSpanRemoved((Cache) proxy, s);
                    return null;
                }
                default:
                    throw new UnsupportedOperationException(method.getName());
            }
        });

        void add(String key, long length, long touchedAt) {
            CacheSpan span = new CacheSpan(key, 0, length, touchedAt, null);
            spans.computeIfAbsent(key, k -> new ArrayList<>()).add(span);
            evictor.onSpanAdded(cache, span);
        }
    }

    private static FakeCache fake(CachePolicy policy, Set<String> pinned) {
        FakeCache f = new FakeCache();
        f.evictor = new RecentTracksEvictor(() -> policy, () -> pinned, null);
        return f;
    }

    @Test
    public void evictsTheOldestTrackOnceTheCountIsExceeded() {
        FakeCache f = fake(CachePolicy.tracks(30), new HashSet<>());
        for (int i = 0; i < 31; i++) f.add("t" + i, 100, 1000 + i);
        assertEquals(1, f.removedKeys.size());
        assertEquals("t0", f.removedKeys.get(0));
        assertFalse(f.spans.containsKey("t0"));
        assertEquals(30, f.spans.size());
    }

    @Test
    public void pinnedDownloadsAreNeverEvictedAndDoNotCount() {
        Set<String> pinned = new HashSet<>();
        pinned.add("dl0");
        pinned.add("dl1");
        FakeCache f = fake(CachePolicy.tracks(30), pinned);
        f.add("dl0", 100, 1);
        f.add("dl1", 100, 2);
        for (int i = 0; i < 30; i++) f.add("t" + i, 100, 1000 + i);
        assertTrue(f.removedKeys.isEmpty());
        f.add("extra", 100, 5000);
        assertEquals(1, f.removedKeys.size());
        assertEquals("t0", f.removedKeys.get(0));
        assertTrue(f.spans.containsKey("dl0"));
        assertTrue(f.spans.containsKey("dl1"));
    }

    @Test
    public void touchingATrackSavesItFromEviction() {
        FakeCache f = fake(CachePolicy.tracks(30), new HashSet<>());
        for (int i = 0; i < 30; i++) f.add("t" + i, 100, 1000 + i);
        f.evictor.touch("t0");
        f.add("new", 100, 1);
        assertEquals("t1", f.removedKeys.get(0));
        assertTrue(f.spans.containsKey("t0"));
    }

    @Test
    public void sizeModeDropsOldTracksUntilTheBudgetFits() {
        long mb300 = 300L * 1024 * 1024;
        FakeCache f = fake(CachePolicy.bytes(CachePolicy.GB), new HashSet<>());
        for (int i = 0; i < 4; i++) f.add("t" + i, mb300, 1000 + i);
        assertEquals(1, f.removedKeys.size());
        assertEquals("t0", f.removedKeys.get(0));
    }

    @Test
    public void reevaluateAppliesANewSmallerBudget() {
        CachePolicy[] current = {CachePolicy.tracks(50)};
        FakeCache f = new FakeCache();
        f.evictor = new RecentTracksEvictor(() -> current[0], () -> new HashSet<>(), null);
        for (int i = 0; i < 40; i++) f.add("t" + i, 10, 1000 + i);
        assertTrue(f.removedKeys.isEmpty());
        current[0] = CachePolicy.tracks(30);
        f.evictor.reevaluate(f.cache);
        assertEquals(10, f.removedKeys.size());
        assertTrue(f.removedKeys.contains("t0"));
        assertFalse(f.removedKeys.contains("t10"));
        assertEquals(30, f.evictor.autoKeys().size());
    }
}
