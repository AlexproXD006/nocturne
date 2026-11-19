package es.alexcloudweb.nocturne.media;

import android.content.Context;
import es.alexcloudweb.nocturne.diag.AppLog;
import androidx.annotation.Nullable;
import es.alexcloudweb.nocturne.widget.WidgetState;
import es.alexcloudweb.nocturne.widget.WidgetUpdater;
import java.util.List;
import org.json.JSONObject;

/**
 * What the home-screen widgets need from the package-private media internals: the saved session as a
 * {@link WidgetState} (service not running), the like toggle that also works with the app closed, and the
 * hook that tells a running service the set of widgets changed. Blocking methods: call off the main thread.
 */
public final class WidgetBridge {
    private static final String TAG = "NocturneWidget";

    private WidgetBridge() {}

    /** The saved playback session, paused, as the widgets show it. */
    public static WidgetState savedState(Context ctx) {
        SessionStore.Restored r = SessionStore.parse(SessionStore.load(ctx));
        if (r == null) return WidgetState.EMPTY;
        List<SessionStore.Entry> es = r.entries;
        SessionStore.Entry cur = es.get(r.index);
        WidgetState.Builder b = new WidgetState.Builder()
            .queue(true)
            .track(cur.trackId, cur.title, cur.artist, cur.artworkUrl)
            .playing(false)
            .liked(likedOf(cur))
            .position(r.positionMs, cur.durationMs);
        for (int i = r.index + 1; i < es.size() && i <= r.index + 3; i++) b.next(es.get(i).title, es.get(i).artist);
        return b.build();
    }

    private static boolean likedOf(SessionStore.Entry e) {
        try {
            return e.trackJson != null && new JSONObject(e.trackJson).optBoolean("liked", false);
        } catch (Throwable t) {
            return false;
        }
    }

    /** A running service lets lyrics load for a new large widget. */
    public static void widgetsChanged() {
        if (EventHub.serviceAlive()) EventHub.withService(NocturneMediaService::onWidgetsChanged);
    }

    /** Heart button: through the running service, or straight to the server from the saved session. */
    public static void toggleLike(Context ctx) {
        if (EventHub.serviceAlive()) {
            EventHub.withService(NocturneMediaService::cmdWidgetLike);
            return;
        }
        final NocturneApi api = NocturneApi.get(ctx);
        SessionStore.Restored r = SessionStore.parse(SessionStore.load(ctx));
        if (r == null || !api.hasSession()) return;
        SessionStore.Entry cur = r.entries.get(r.index);
        final boolean now = !likedOf(cur);
        WidgetUpdater u = WidgetUpdater.get(ctx);
        applyLiked(ctx, cur.trackId, now);
        u.pushFull(savedState(ctx));
        try {
            api.request(now ? "PUT" : "DELETE", "/v1/library/tracks/" + NocturneApi.pathId(cur.trackId), null);
        } catch (Throwable t) {
            AppLog.w(TAG, "like failed: " + t.getClass().getSimpleName());
            applyLiked(ctx, cur.trackId, !now);
            u.pushFull(savedState(ctx));
        }
    }

    private static void applyLiked(Context ctx, String trackId, boolean liked) {
        @Nullable String json = SessionStore.load(ctx);
        String next = SessionStore.withLiked(json, trackId, liked);
        if (next != null) SessionStore.saveRaw(ctx, next);
    }
}
