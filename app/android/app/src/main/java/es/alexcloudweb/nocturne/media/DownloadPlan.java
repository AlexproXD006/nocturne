package es.alexcloudweb.nocturne.media;

import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.scheduler.Requirements;
import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Pure decisions behind the downloads wiring (unit-tested): how a Media3 download state is shown to the
 * WebView, which network requirement applies, the storage limit check and the request id / uri of a track.
 */
final class DownloadPlan {
    /** Stop reason used for a user pause (0 = not stopped). */
    static final int STOP_USER_PAUSED = 1;

    private DownloadPlan() {}

    /** queued | downloading | paused | done | failed | removing. */
    static String stateName(int state, int stopReason) {
        switch (state) {
            case Download.STATE_COMPLETED:
                return "done";
            case Download.STATE_FAILED:
                return "failed";
            case Download.STATE_REMOVING:
                return "removing";
            case Download.STATE_DOWNLOADING:
                return "downloading";
            case Download.STATE_STOPPED:
                return stopReason == STOP_USER_PAUSED ? "paused" : "queued";
            default: // QUEUED, RESTARTING
                return "queued";
        }
    }

    /** Wi-Fi only maps to "unmetered network"; otherwise any network. */
    static int requirements(boolean wifiOnly) {
        return wifiOnly ? Requirements.NETWORK_UNMETERED : Requirements.NETWORK;
    }

    /** 0..100 (rounded), or -1 while unknown. */
    static int percent(float p, boolean done) {
        if (done) return 100;
        if (Float.isNaN(p) || p < 0) return -1;
        return Math.min(100, Math.round(p));
    }

    /** True when starting {@code incoming} more bytes would exceed a non-zero {@code limit}. */
    static boolean overLimit(long usedPinned, long incoming, long limit) {
        return limit > 0 && usedPinned + Math.max(0, incoming) > limit;
    }

    static String uriOf(String trackId) {
        return "nocturne://track/" + MediaIds.enc(trackId).replace("+", "%20");
    }

    /** One row of the downloads list as the WebView sees it. */
    static JSONObject item(String id, int state, int stopReason, float percent, long bytes, long total) throws JSONException {
        boolean done = state == Download.STATE_COMPLETED;
        return new JSONObject()
            .put("id", id)
            .put("state", stateName(state, stopReason))
            .put("percent", percent(percent, done))
            .put("bytes", Math.max(0, bytes))
            .put("total", Math.max(0, total));
    }

    static String summary(int done, int total) {
        return String.format(Locale.ROOT, "%d/%d", done, total);
    }
}
