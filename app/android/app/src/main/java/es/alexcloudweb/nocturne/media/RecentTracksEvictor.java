package es.alexcloudweb.nocturne.media;

import androidx.annotation.Nullable;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.cache.Cache;
import androidx.media3.datasource.cache.CacheEvictor;
import androidx.media3.datasource.cache.CacheSpan;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Media3 {@link CacheEvictor} that keeps the N most recently played auto-cached tracks (see
 * {@link CachePolicy}) and never evicts pinned (downloaded) ones. The cache key is the track id, so
 * all spans of a track are evicted together.
 */
@UnstableApi
final class RecentTracksEvictor implements CacheEvictor {
    interface Listener {
        /** All spans of {@code key} are gone. */
        void onEvicted(String key);
    }

    private final Supplier<CachePolicy> policy;
    private final Supplier<Set<String>> pinned;
    @Nullable private final Listener listener;
    private final Map<String, CachePolicy.Entry> entries = new HashMap<>();

    RecentTracksEvictor(Supplier<CachePolicy> policy, Supplier<Set<String>> pinned, @Nullable Listener listener) {
        this.policy = policy;
        this.pinned = pinned;
        this.listener = listener;
    }

    @Override
    public boolean requiresCacheSpanTouches() {
        return true;
    }

    @Override
    public void onCacheInitialized() {
        // Spans found on disk were reported through onSpanAdded.
    }

    @Override
    public synchronized void onStartFile(Cache cache, String key, long position, long length) {
        touchLocked(key, System.currentTimeMillis());
        if (length != androidx.media3.common.C.LENGTH_UNSET) evict(cache, key);
    }

    @Override
    public synchronized void onSpanAdded(Cache cache, CacheSpan span) {
        CachePolicy.Entry e = entries.get(span.key);
        if (e == null) {
            e = new CachePolicy.Entry(span.key, 0, 0);
            entries.put(span.key, e);
        }
        e.bytes += span.length;
        e.lastUsed = Math.max(e.lastUsed, span.lastTouchTimestamp);
        evict(cache, span.key);
    }

    @Override
    public synchronized void onSpanRemoved(Cache cache, CacheSpan span) {
        CachePolicy.Entry e = entries.get(span.key);
        if (e == null) return;
        e.bytes -= span.length;
        if (e.bytes <= 0) entries.remove(span.key);
    }

    @Override
    public synchronized void onSpanTouched(Cache cache, CacheSpan oldSpan, CacheSpan newSpan) {
        onSpanRemoved(cache, oldSpan);
        onSpanAdded(cache, newSpan);
        touchLocked(newSpan.key, System.currentTimeMillis());
    }

    /** The user played this track now: it becomes the most recent one. */
    synchronized void touch(String key) {
        touchLocked(key, System.currentTimeMillis());
    }

    private void touchLocked(String key, long now) {
        // Only tracks that have bytes in the cache take part in the policy (no ghost entries).
        CachePolicy.Entry e = entries.get(key);
        if (e != null) e.lastUsed = Math.max(e.lastUsed, now);
    }

    /** Re-applies the policy (settings changed, or a download was removed). */
    synchronized void reevaluate(Cache cache) {
        evict(cache, null);
    }

    private void evict(Cache cache, @Nullable String protectKey) {
        Set<String> protect = protectKey == null ? Collections.<String>emptySet() : Collections.singleton(protectKey);
        List<String> victims = policy.get().victims(new ArrayList<>(entries.values()), pinned.get(), protect);
        for (String key : victims) {
            for (CacheSpan span : new ArrayList<>(cache.getCachedSpans(key))) {
                try {
                    cache.removeSpan(span);
                } catch (RuntimeException ignored) {
                    /* will be retried on the next pass */
                }
            }
            CachePolicy.Entry e = entries.get(key);
            if (e != null && e.bytes <= 0) entries.remove(key);
            if (listener != null) listener.onEvicted(key);
        }
    }

    /** Keys currently tracked that are not pinned (the auto cache). */
    synchronized Set<String> autoKeys() {
        Set<String> out = new HashSet<>(entries.keySet());
        out.removeAll(pinned.get());
        return out;
    }

    synchronized long bytesOf(String key) {
        CachePolicy.Entry e = entries.get(key);
        return e == null ? 0 : e.bytes;
    }
}
