package es.alexcloudweb.nocturne.media;

import android.app.NotificationManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadCursor;
import androidx.media3.exoplayer.offline.DownloadManager;
import androidx.media3.exoplayer.offline.DownloadRequest;
import androidx.media3.exoplayer.offline.DefaultDownloadIndex;
import androidx.media3.exoplayer.offline.DefaultDownloaderFactory;
import androidx.media3.exoplayer.offline.DownloadService;
import androidx.media3.exoplayer.scheduler.Requirements;
import es.alexcloudweb.nocturne.diag.AppLog;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Owns the Media3 {@link DownloadManager} (same {@link OfflineCache} as playback, 2 parallel downloads,
 * Wi-Fi requirement from the settings) and turns its state into JSON for the WebView and the Android Auto
 * "Downloads" node. The request data holds the full Track JSON so the list works with no network.
 * Downloaded tracks are pinned (never evicted by the automatic cache).
 */
@UnstableApi
final class DownloadsController {
    private static final String TAG = "Downloads";
    static final int MAX_PARALLEL = 2;
    private static final long PUSH_MS = 400;

    interface Sink {
        void emit(JSONObject event);
    }

    private static DownloadsController instance;

    static synchronized DownloadsController get(Context ctx) {
        if (instance == null) instance = new DownloadsController(ctx.getApplicationContext());
        return instance;
    }

    @Nullable private static volatile Sink sink;

    static void setSink(@Nullable Sink s) {
        sink = s;
    }

    private final Context app;
    private final DownloadManager manager;
    private final DefaultDownloadIndex index;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Executor io = Executors.newFixedThreadPool(2);
    private boolean pushQueued;
    private int completedSinceIdle;
    private final Runnable push = () -> {
        pushQueued = false;
        emitState();
    };

    private DownloadsController(Context app) {
        this.app = app;
        OfflineCache oc = OfflineCache.get(app);
        this.index = new DefaultDownloadIndex(oc.database());
        Executor exec = Executors.newFixedThreadPool(MAX_PARALLEL + 1);
        this.manager = new DownloadManager(app, index, new DefaultDownloaderFactory(oc.dataSources(), exec));
        manager.setMaxParallelDownloads(MAX_PARALLEL);
        manager.setRequirements(new Requirements(DownloadPlan.requirements(OfflinePrefs.downloadsWifiOnly(app))));
        manager.addListener(new DownloadManager.Listener() {
            @Override
            public void onDownloadChanged(DownloadManager m, Download d, @Nullable Exception e) {
                if (d.state == Download.STATE_COMPLETED) completedSinceIdle++;
                if (e != null) AppLog.w(TAG, "download failed: " + e.getClass().getSimpleName());
                schedulePush();
            }

            @Override
            public void onDownloadRemoved(DownloadManager m, Download d) {
                OfflinePrefs.unpin(app, d.request.id);
                OfflineMeta.delete(app, d.request.id);
                oc.reevaluate();
                schedulePush();
            }

            @Override
            public void onIdle(DownloadManager m) {
                emitState();
                int n = completedSinceIdle;
                completedSinceIdle = 0;
                if (n > 0) notifyDone(n);
            }

            @Override
            public void onRequirementsStateChanged(DownloadManager m, Requirements r, int notMet) {
                schedulePush();
            }
        });
    }

    DownloadManager manager() {
        return manager;
    }

    /** Applies Wi-Fi only / the cache budget after a settings change. */
    void applySettings() {
        manager.setRequirements(new Requirements(DownloadPlan.requirements(OfflinePrefs.downloadsWifiOnly(app))));
        OfflineCache.get(app).reevaluate();
    }

    /** Queues one track (raw Track JSON from the server). Pins it. */
    void enqueue(JSONObject track) {
        String id = track.optString("id", "");
        if (id.isEmpty()) return;
        OfflinePrefs.pin(app, id);
        DownloadRequest req = new DownloadRequest.Builder(id, android.net.Uri.parse(DownloadPlan.uriOf(id)))
            .setCustomCacheKey(id)
            .setData(track.toString().getBytes(StandardCharsets.UTF_8))
            .build();
        try {
            DownloadService.sendAddDownload(app, NocturneDownloadService.class, req, /* stopReason= */ 0, /* foreground= */ true);
        } catch (RuntimeException e) {
            // Foreground start refused (app not in a state to start one): queue it; it runs when the service next starts.
            AppLog.w(TAG, "foreground download start refused: " + e.getClass().getSimpleName());
            DownloadService.sendAddDownload(app, NocturneDownloadService.class, req, 0, false);
        }
        final NocturneApi api = NocturneApi.get(app);
        io.execute(() -> OfflineMeta.fetch(app, api, id));
    }

    void pause(String id) {
        DownloadService.sendSetStopReason(app, NocturneDownloadService.class, id, DownloadPlan.STOP_USER_PAUSED, false);
    }

    void resume(String id) {
        DownloadService.sendSetStopReason(app, NocturneDownloadService.class, id, Download.STOP_REASON_NONE, true);
    }

    void remove(String id) {
        DownloadService.sendRemoveDownload(app, NocturneDownloadService.class, id, false);
    }

    void removeAll() {
        DownloadService.sendRemoveAllDownloads(app, NocturneDownloadService.class, false);
    }

    /** Every download the index knows (completed ones are what plays offline). */
    List<Download> all() {
        List<Download> out = new ArrayList<>();
        try (DownloadCursor c = index.getDownloads()) {
            while (c.moveToNext()) out.add(c.getDownload());
        } catch (IOException e) {
            AppLog.w(TAG, "could not read the download index");
        }
        return out;
    }

    /** Track JSON of every completed download, newest first. */
    List<JSONObject> completedTracks() {
        List<Download> list = all();
        List<JSONObject> out = new ArrayList<>();
        java.util.Collections.sort(list, (a, b) -> Long.compare(b.updateTimeMs, a.updateTimeMs));
        for (Download d : list) {
            if (d.state != Download.STATE_COMPLETED) continue;
            JSONObject t = trackOf(d);
            if (t != null) out.add(t);
        }
        return out;
    }

    @Nullable
    static JSONObject trackOf(Download d) {
        try {
            return new JSONObject(new String(d.request.data, StandardCharsets.UTF_8));
        } catch (JSONException e) {
            return null;
        }
    }

    JSONObject stateJson() {
        JSONArray items = new JSONArray();
        long pinnedBytes = 0;
        try {
            for (Download d : all()) {
                items.put(DownloadPlan.item(d.request.id, d.state, d.stopReason, d.getPercentDownloaded(), d.getBytesDownloaded(), d.contentLength));
                pinnedBytes += Math.max(0, d.getBytesDownloaded());
            }
            long[] usage = OfflineCache.get(app).usage();
            return new JSONObject()
                .put("downloads", items)
                .put("autoBytes", usage[0])
                .put("pinnedBytes", usage[1])
                .put("autoTracks", OfflineCache.get(app).autoTrackCount())
                .put("limitBytes", OfflinePrefs.limitBytes(app))
                .put("paused", manager.getDownloadsPaused());
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private void schedulePush() {
        main.post(() -> {
            if (pushQueued) return;
            pushQueued = true;
            main.postDelayed(push, PUSH_MS);
        });
    }

    private void emitState() {
        Sink s = sink;
        if (s == null) return;
        try {
            s.emit(new JSONObject().put("type", "downloads").put("state", stateJson()));
        } catch (JSONException ignored) {
            /* never */
        }
    }

    private void notifyDone(int n) {
        try {
            NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            androidx.core.app.NotificationCompat.Builder b = new androidx.core.app.NotificationCompat.Builder(app, NocturneDownloadService.CHANNEL_ID)
                .setSmallIcon(es.alexcloudweb.nocturne.R.drawable.ic_stat_nocturne)
                .setContentTitle(app.getString(es.alexcloudweb.nocturne.R.string.nocturne_dl_done_title))
                .setContentText(app.getResources().getQuantityString(es.alexcloudweb.nocturne.R.plurals.nocturne_dl_done_text, n, n))
                .setAutoCancel(true);
            nm.notify(NocturneDownloadService.DONE_NOTIFICATION_ID, b.build());
        } catch (RuntimeException e) {
            AppLog.w(TAG, "completion notification failed");
        }
    }
}
