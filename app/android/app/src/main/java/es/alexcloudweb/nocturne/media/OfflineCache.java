package es.alexcloudweb.nocturne.media;

import android.content.Context;
import android.net.Uri;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.database.DatabaseProvider;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.datasource.cache.Cache;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.CacheKeyFactory;
import androidx.media3.datasource.cache.ContentMetadata;
import androidx.media3.datasource.cache.SimpleCache;
import es.alexcloudweb.nocturne.diag.AppLog;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The single {@link SimpleCache} shared by playback (automatic cache of the last played tracks, written
 * while streaming so nothing is downloaded twice) and by the {@code DownloadManager} (pinned downloads).
 *
 * <p>Lives in the app's files dir (not cacheDir: the OS may purge that). The cache key is the track id,
 * never the signed URL, so a track cached today plays offline tomorrow whatever URL the server signs.
 * The cache wraps the resolving data source: signed URLs are only resolved on a cache miss.
 */
@UnstableApi
final class OfflineCache {
    private static final String TAG = "OfflineCache";

    private static OfflineCache instance;

    static synchronized OfflineCache get(Context ctx) {
        if (instance == null) instance = new OfflineCache(ctx.getApplicationContext());
        return instance;
    }

    private final Context app;
    private final DatabaseProvider db;
    private final RecentTracksEvictor evictor;
    private final SimpleCache cache;

    private OfflineCache(Context app) {
        this.app = app;
        this.db = new StandaloneDatabaseProvider(app);
        this.evictor = new RecentTracksEvictor(() -> OfflinePrefs.policy(app), () -> OfflinePrefs.pinned(app), key -> OfflineMeta.delete(app, key));
        this.cache = new SimpleCache(new File(app.getFilesDir(), "offline/media"), evictor, db);
    }

    SimpleCache cache() {
        return cache;
    }

    DatabaseProvider database() {
        return db;
    }

    RecentTracksEvictor evictor() {
        return evictor;
    }

    /** Track id behind a data spec: its explicit key, or the id in {@code nocturne://track/ID}. */
    static String keyOf(DataSpec spec) {
        if (spec.key != null) return spec.key;
        Uri u = spec.uri;
        if ("nocturne".equals(u.getScheme()) && "track".equals(u.getHost())) {
            String seg = u.getLastPathSegment();
            if (seg != null) return seg;
        }
        return u.toString();
    }

    static final CacheKeyFactory KEYS = OfflineCache::keyOf;

    /** Signed-URL resolver + HTTP, no cache. */
    static DataSource.Factory upstream(Context ctx) {
        final NocturneApi api = NocturneApi.get(ctx);
        return new ResolvingDataSource.Factory(
            new DefaultDataSource.Factory(ctx, new DefaultHttpDataSource.Factory().setUserAgent("Nocturne-Android").setAllowCrossProtocolRedirects(true)),
            dataSpec -> {
                Uri u = dataSpec.uri;
                if ("nocturne".equals(u.getScheme()) && "track".equals(u.getHost())) {
                    String id = u.getLastPathSegment();
                    if (id == null) throw new IOException("bad track uri");
                    return dataSpec.withUri(Uri.parse(api.streamUrl(id)));
                }
                return dataSpec;
            });
    }

    /** Playback and downloads read through (and write into) the cache. */
    CacheDataSource.Factory dataSources() {
        return new CacheDataSource.Factory()
            .setCache(cache)
            .setCacheKeyFactory(KEYS)
            .setUpstreamDataSourceFactory(upstream(app))
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
    }

    /** True when every byte of the track is in the cache (playable with no network). */
    boolean isFullyCached(String key) {
        try {
            long len = ContentMetadata.getContentLength(cache.getContentMetadata(key));
            return len > 0 && cache.isCached(key, 0, len);
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** Ids of every fully cached track (auto + pinned). */
    Set<String> fullyCachedKeys() {
        Set<String> out = new HashSet<>();
        for (String k : new ArrayList<>(cache.getKeys())) if (isFullyCached(k)) out.add(k);
        return out;
    }

    /** Bytes of the auto cache (not pinned) and of the pinned downloads. */
    long[] usage() {
        Set<String> pinned = OfflinePrefs.pinned(app);
        long auto = 0;
        long pin = 0;
        for (String k : new ArrayList<>(cache.getKeys())) {
            long b = 0;
            for (androidx.media3.datasource.cache.CacheSpan s : cache.getCachedSpans(k)) b += s.length;
            if (pinned.contains(k)) pin += b;
            else auto += b;
        }
        return new long[] {auto, pin};
    }

    int autoTrackCount() {
        Set<String> pinned = OfflinePrefs.pinned(app);
        int n = 0;
        for (String k : new ArrayList<>(cache.getKeys())) if (!pinned.contains(k) && isFullyCached(k)) n++;
        return n;
    }

    /** "Vaciar caché": removes every auto-cached track (never the pinned ones). */
    void clearAuto() {
        Set<String> pinned = OfflinePrefs.pinned(app);
        List<String> keys = new ArrayList<>(cache.getKeys());
        for (String k : keys) {
            if (pinned.contains(k)) continue;
            removeKey(k);
        }
    }

    void removeKey(String key) {
        try {
            cache.removeResource(key);
        } catch (RuntimeException e) {
            AppLog.w(TAG, "could not remove " + key, e);
        }
        OfflineMeta.delete(app, key);
    }

    /** Settings changed: apply the new budget now. */
    void reevaluate() {
        evictor.reevaluate(cache);
    }

    @Nullable
    static OfflineCache peek() {
        return instance;
    }
}
