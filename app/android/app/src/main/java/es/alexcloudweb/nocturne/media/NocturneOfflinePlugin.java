package es.alexcloudweb.nocturne.media;

import android.content.Context;
import android.net.ConnectivityManager;
import androidx.annotation.Nullable;
import androidx.media3.common.util.UnstableApi;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import es.alexcloudweb.nocturne.diag.AppLog;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * JS API ({@code registerPlugin('NocturneOffline')}): downloads (Media3 DownloadManager + foreground
 * DownloadService), the automatic cache of recent tracks and native connectivity.
 *
 * <ul>
 *   <li>{@code configure}: cache budget (tracks or bytes), downloads Wi-Fi only, prefetch Wi-Fi only, storage limit.
 *   <li>{@code download / pause / resume / cancel / removeAll / pauseAll / resumeAll}: the downloads queue.
 *   <li>{@code state}: downloads + storage usage. {@code availability}: which track ids play with no network.
 *   <li>{@code clearCache}: empties the automatic cache (never downloads).
 *   <li>event {@code event}: {@code downloads} (state) and {@code network} (online).
 * </ul>
 */
@UnstableApi
@CapacitorPlugin(name = "NocturneOffline")
public class NocturneOfflinePlugin extends Plugin {
    private static final String TAG = "NocturneOffline";

    @Nullable private ConnectivityManager.NetworkCallback netCallback;

    @Override
    public void load() {
        final Context ctx = getContext();
        DownloadsController.setSink(event -> {
            try {
                notifyListeners("event", new JSObject(event.toString()));
            } catch (JSONException e) {
                AppLog.w(TAG, "event not delivered");
            }
        });
        netCallback = NetMonitor.watch(ctx, online -> {
            try {
                notifyListeners("event", new JSObject(new JSONObject().put("type", "network").put("online", online).put("unmetered", NetMonitor.isUnmetered(ctx)).toString()));
            } catch (JSONException ignored) {
                /* never */
            }
        });
        // Creates the controller so downloads left queued by an earlier run resume (service + scheduler).
        DownloadsController.get(ctx);
    }

    @Override
    protected void handleOnDestroy() {
        DownloadsController.setSink(null);
        NetMonitor.unwatch(getContext(), netCallback);
        netCallback = null;
        super.handleOnDestroy();
    }

    @PluginMethod
    public void configure(PluginCall call) {
        Context ctx = getContext();
        OfflinePrefs.save(
            ctx,
            call.getInt("autoTracks", CachePolicy.DEFAULT_TRACKS),
            (long) call.getDouble("autoBytes", 0.0).doubleValue(),
            Boolean.TRUE.equals(call.getBoolean("wifiOnly", true)),
            Boolean.TRUE.equals(call.getBoolean("prefetchWifiOnly", true)),
            (long) call.getDouble("limitBytes", 0.0).doubleValue());
        io(() -> DownloadsController.get(ctx).applySettings());
        call.resolve();
    }

    @PluginMethod
    public void download(PluginCall call) {
        Context ctx = getContext();
        JSONArray tracks = call.getArray("tracks");
        final DownloadsController dc = DownloadsController.get(ctx);
        long limit = OfflinePrefs.limitBytes(ctx);
        int accepted = 0;
        int rejected = 0;
        if (tracks != null) {
            long pinned = OfflineCache.get(ctx).usage()[1];
            for (int i = 0; i < tracks.length(); i++) {
                JSONObject t = tracks.optJSONObject(i);
                if (t == null) continue;
                if (DownloadPlan.overLimit(pinned, 0, limit)) {
                    rejected++;
                    continue;
                }
                dc.enqueue(t);
                accepted++;
            }
        }
        JSObject res = new JSObject();
        res.put("accepted", accepted);
        res.put("rejected", rejected);
        call.resolve(res);
    }

    @PluginMethod
    public void pause(PluginCall call) {
        String id = call.getString("id", "");
        if (!id.isEmpty()) DownloadsController.get(getContext()).pause(id);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        String id = call.getString("id", "");
        if (!id.isEmpty()) DownloadsController.get(getContext()).resume(id);
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        JSONArray ids = call.getArray("ids");
        DownloadsController dc = DownloadsController.get(getContext());
        if (ids != null) for (int i = 0; i < ids.length(); i++) {
            String id = ids.optString(i, "");
            if (!id.isEmpty()) dc.remove(id);
        }
        call.resolve();
    }

    @PluginMethod
    public void removeAll(PluginCall call) {
        DownloadsController.get(getContext()).removeAll();
        call.resolve();
    }

    @PluginMethod
    public void clearCache(PluginCall call) {
        final Context ctx = getContext();
        io(() -> {
            OfflineCache.get(ctx).clearAuto();
            JSObject res = new JSObject();
            call.resolve(res);
        });
    }

    @PluginMethod
    public void state(PluginCall call) {
        final Context ctx = getContext();
        io(() -> {
            try {
                call.resolve(new JSObject(DownloadsController.get(ctx).stateJson().toString()));
            } catch (JSONException e) {
                call.reject("state failed");
            }
        });
    }

    @PluginMethod
    public void availability(PluginCall call) {
        final Context ctx = getContext();
        final JSONArray ids = call.getArray("ids");
        io(() -> {
            OfflineCache oc = OfflineCache.get(ctx);
            Set<String> pinned = OfflinePrefs.pinned(ctx);
            JSONArray available = new JSONArray();
            JSONArray pins = new JSONArray();
            Set<String> seen = new HashSet<>();
            if (ids != null) {
                for (int i = 0; i < ids.length(); i++) {
                    String id = ids.optString(i, "");
                    if (id.isEmpty() || !seen.add(id)) continue;
                    if (oc.isFullyCached(id)) {
                        available.put(id);
                        if (pinned.contains(id)) pins.put(id);
                    }
                }
            }
            JSObject res = new JSObject();
            res.put("available", available);
            res.put("pinned", pins);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void network(PluginCall call) {
        Context ctx = getContext();
        JSObject res = new JSObject();
        res.put("online", NetMonitor.isOnline(ctx));
        res.put("unmetered", NetMonitor.isUnmetered(ctx));
        call.resolve(res);
    }

    private static void io(Runnable r) {
        new Thread(() -> {
            try {
                r.run();
            } catch (Throwable t) {
                AppLog.w(TAG, "offline task failed", t);
            }
        }, "nocturne-offline").start();
    }
}
