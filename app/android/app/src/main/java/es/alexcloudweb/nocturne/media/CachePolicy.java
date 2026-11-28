package es.alexcloudweb.nocturne.media;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Set;

/**
 * Which automatically cached tracks to evict. Pure Java (unit-tested); the Media3 adapter is
 * {@link RecentTracksEvictor}.
 *
 * <p>Two modes: keep the {@code maxTracks} most recently played tracks (default 30), or keep as many of
 * the most recently played ones as fit in {@code maxBytes}. Pinned tracks (downloads) are never evicted
 * and do not count toward either budget, and a protected key (the one being written / played right now)
 * is never evicted either.
 */
final class CachePolicy {
    static final int DEFAULT_TRACKS = 30;
    /** Choices offered in Settings. */
    static final int[] TRACK_CHOICES = {30, 50, 100, 200};
    static final long GB = 1024L * 1024L * 1024L;
    static final long[] BYTE_CHOICES = {GB, 2 * GB, 5 * GB};

    /** One cached track (all its spans together). */
    static final class Entry {
        final String key;
        long bytes;
        long lastUsed;

        Entry(String key, long bytes, long lastUsed) {
            this.key = key;
            this.bytes = bytes;
            this.lastUsed = lastUsed;
        }
    }

    final int maxTracks;
    /** 0 = count mode. */
    final long maxBytes;

    CachePolicy(int maxTracks, long maxBytes) {
        this.maxTracks = maxTracks;
        this.maxBytes = Math.max(0, maxBytes);
    }

    static CachePolicy tracks(int n) {
        return new CachePolicy(sanitizeTracks(n), 0);
    }

    static CachePolicy bytes(long b) {
        return new CachePolicy(DEFAULT_TRACKS, b);
    }

    static int sanitizeTracks(int n) {
        for (int c : TRACK_CHOICES) if (c == n) return n;
        return DEFAULT_TRACKS;
    }

    /** Only the three offered sizes are valid; anything else falls back to count mode. */
    static long sanitizeBytes(long b) {
        for (long c : BYTE_CHOICES) if (c == b) return b;
        return 0;
    }

    /** Keys to evict (the oldest ones; listed most recent of them first). */
    List<String> victims(Collection<Entry> entries, Set<String> pinned, Set<String> protect) {
        List<Entry> auto = new ArrayList<>();
        for (Entry e : entries) if (!pinned.contains(e.key)) auto.add(e);
        // Most recently used first; the key as tie-break keeps the result deterministic.
        Collections.sort(auto, (a, b) -> a.lastUsed != b.lastUsed ? Long.compare(b.lastUsed, a.lastUsed) : a.key.compareTo(b.key));
        List<String> out = new ArrayList<>();
        // Protected tracks are always kept and use up part of the budget first.
        long used = 0;
        int kept = 0;
        for (Entry e : auto) {
            if (protect.contains(e.key)) {
                kept++;
                used += e.bytes;
            }
        }
        for (Entry e : auto) {
            if (protect.contains(e.key)) continue;
            // In size mode the most recent track is always kept, even when it alone is over budget.
            boolean keep = maxBytes > 0 ? kept == 0 || used + e.bytes <= maxBytes : kept < maxTracks;
            if (keep) {
                kept++;
                used += e.bytes;
            } else {
                out.add(e.key);
            }
        }
        return out;
    }
}
