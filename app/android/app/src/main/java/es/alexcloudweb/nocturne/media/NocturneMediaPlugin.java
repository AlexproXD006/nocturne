package es.alexcloudweb.nocturne.media;

import android.content.ComponentName;
import android.content.Context;
import android.os.Looper;
import es.alexcloudweb.nocturne.diag.AppLog;
import androidx.annotation.MainThread;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;
import es.alexcloudweb.nocturne.widget.AppThemeStore;
import es.alexcloudweb.nocturne.widget.KeyValueStore;
import es.alexcloudweb.nocturne.widget.WidgetUpdater;
import androidx.media3.common.MediaItem;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * JS API ({@code registerPlugin('NocturneMedia')}), a remote control for the Media3 service
 * ({@link NocturneMediaService}) that actually plays:
 * <ul>
 *   <li>{@code setQueue / play / pause / seek / setVolume / setRepeat / setShuffle / setPauseAtEnd / stop /
 *       setLiked / setLyricsInCar}: transport and queue.
 *   <li>{@code setAppTheme}: the app's theme and accent, kept natively for the home-screen widgets.
 *   <li>{@code setEq}: equalizer state (enabled, preamp, 10 gains), persisted natively and applied by the service.
 *   <li>{@code setAuth / getAuth}: the session handed to native secure storage.
 *   <li>{@code getSnapshot}: the native queue (adopted when Android Auto started playback).
 *   <li>event {@code event}: state, position, index, error, queue, liked, command, auth.
 * </ul>
 *
 * <p>While the WebView lives the plugin keeps a {@link MediaController} connected: that binding creates
 * the service (from the foreground app, which keeps Android 14+ happy). The service outlives the activity.
 */
@CapacitorPlugin(name = "NocturneMedia")
public class NocturneMediaPlugin extends Plugin {
    private static final String TAG = "NocturneMedia";

    @Nullable private ListenableFuture<MediaController> controllerFuture;

    @Override
    public void load() {
        EventHub.setSink(event -> {
            try {
                notifyListeners("event", new JSObject(event.toString()));
            } catch (JSONException e) {
                AppLog.w(TAG, "event not delivered");
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        // The WebView is going away; playback continues in the service.
        EventHub.setSink(null);
        EventHub.runOnMain(this::releaseController);
        super.handleOnDestroy();
    }

    @PluginMethod
    public void setQueue(PluginCall call) {
        JSONArray arr = call.getArray("items");
        final int index = call.getInt("index", 0);
        final Boolean play = call.hasOption("play") && !call.getData().isNull("play") ? call.getBoolean("play", true) : null;
        final long startMs = (long) (call.getDouble("startAt", 0.0) * 1000);
        final boolean reset = Boolean.TRUE.equals(call.getBoolean("reset", false));
        final List<MediaItem> items = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && !o.optString("uid", "").isEmpty() && !o.optString("trackId", "").isEmpty()) {
                    items.add(NocturneMediaService.itemFromJs(o));
                }
            }
        }
        if (!items.isEmpty()) {
            EventHub.runOnMain(this::ensureConnected);
            EventHub.withService(s -> s.cmdSetQueue(items, index, play, startMs, reset));
        }
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        EventHub.runOnMain(this::ensureConnected);
        EventHub.withService(NocturneMediaService::cmdPlay);
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        if (EventHub.serviceAlive()) EventHub.withService(NocturneMediaService::cmdPause);
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        final double position = call.getDouble("position", 0.0);
        if (EventHub.serviceAlive()) EventHub.withService(s -> s.cmdSeek(position));
        call.resolve();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        final double volume = call.getDouble("volume", 1.0);
        if (EventHub.serviceAlive()) EventHub.withService(s -> s.cmdSetVolume(volume));
        call.resolve();
    }

    @PluginMethod
    public void setRepeat(PluginCall call) {
        final String mode = call.getString("mode", "off");
        if (EventHub.serviceAlive()) EventHub.withService(s -> s.cmdSetRepeat(mode));
        call.resolve();
    }

    @PluginMethod
    public void setShuffle(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        if (EventHub.serviceAlive()) EventHub.withService(s -> s.cmdSetShuffleFlag(on));
        call.resolve();
    }

    @PluginMethod
    public void setPauseAtEnd(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        if (EventHub.serviceAlive()) EventHub.withService(s -> s.cmdSetPauseAtEnd(on));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (EventHub.serviceAlive()) {
            EventHub.withService(NocturneMediaService::cmdStop);
            EventHub.runOnMain(this::releaseController);
        }
        call.resolve();
    }

    @PluginMethod
    public void setLiked(PluginCall call) {
        final String trackId = call.getString("trackId", "");
        final boolean liked = Boolean.TRUE.equals(call.getBoolean("liked", false));
        if (EventHub.serviceAlive() && !trackId.isEmpty()) EventHub.withService(s -> s.cmdSetLiked(trackId, liked));
        call.resolve();
    }

    @PluginMethod
    public void setLyricsInCar(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        if (EventHub.serviceAlive()) EventHub.withService(s -> s.cmdSetLyricsEnabled(enabled));
        else LyricsPref.set(getContext(), enabled);
        call.resolve();
    }

    /** The app's current theme + accent, for the widgets' "Like the app" colours. Stored natively, no service needed. */
    @PluginMethod
    public void setAppTheme(PluginCall call) {
        Context ctx = getContext();
        if (ctx != null) {
            AppThemeStore.save(KeyValueStore.prefs(ctx), AppThemeStore.sanitize(call.getString("theme", ""), call.getString("accent", "")));
            WidgetUpdater.get(ctx).refreshAll();
        }
        call.resolve();
    }

    @PluginMethod
    public void setEq(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        final double preamp = call.getDouble("preamp", 0.0);
        double[] gains = new double[EqDsp.BANDS];
        JSONArray arr = call.getArray("gains");
        for (int i = 0; i < gains.length; i++) gains[i] = arr == null ? 0 : arr.optDouble(i, 0);
        final EqPrefs.State state = new EqPrefs.State(enabled, preamp, gains);
        // Persisted first: a service that is not running (or restarts later) reads it on creation.
        EqPrefs.save(getContext(), state);
        if (EventHub.serviceAlive()) EventHub.withService(s -> s.cmdSetEq(state));
        call.resolve();
    }

    @PluginMethod
    public void setAuth(PluginCall call) {
        Context ctx = getContext();
        if (ctx != null) {
            JSONObject o = call.getObject("session");
            NocturneAuth.Session s = o == null ? null : NocturneAuth.Session.fromJson(o);
            NocturneApi.get(ctx).setSession(s);
        }
        call.resolve();
    }

    @PluginMethod
    public void getAuth(PluginCall call) {
        JSObject res = new JSObject();
        Context ctx = getContext();
        NocturneAuth.Session s = ctx == null ? null : NocturneApi.get(ctx).session();
        try {
            res.put("session", s == null ? JSONObject.NULL : s.toJson());
        } catch (JSONException e) {
            res.put("session", JSONObject.NULL);
        }
        call.resolve(res);
    }

    @PluginMethod
    public void getSnapshot(PluginCall call) {
        // The service may not exist yet (app just started, or it was stopped while paused): connecting
        // creates it, and it restores the saved session, so the WebView can adopt the last song.
        EventHub.runOnMain(this::ensureConnected);
        EventHub.withService(s -> {
            JSObject res = new JSObject();
            JSONObject snap = s.snapshot();
            res.put("snapshot", snap == null ? JSONObject.NULL : snap);
            call.resolve(res);
        });
    }

    @MainThread
    private void releaseController() {
        ListenableFuture<MediaController> f = controllerFuture;
        controllerFuture = null;
        if (f != null) {
            try {
                MediaController.releaseFuture(f);
            } catch (Throwable t) {
                AppLog.w(TAG, "controller release failed", t);
            }
        }
    }

    /** Binds to the media service (creating it) unless already bound or binding. */
    @MainThread
    private void ensureConnected() {
        if (controllerFuture != null) return;
        Context ctx = getContext();
        if (ctx == null) return;
        final Context app = ctx.getApplicationContext();
        try {
            SessionToken token = new SessionToken(app, new ComponentName(app, NocturneMediaService.class));
            final AtomicReference<ListenableFuture<MediaController>> self = new AtomicReference<>();
            ListenableFuture<MediaController> f = new MediaController.Builder(app, token)
                .setApplicationLooper(Looper.getMainLooper())
                .setListener(new MediaController.Listener() {
                    @Override
                    public void onDisconnected(MediaController controller) {
                        // Service died or was stopped: reconnect on the next command.
                        if (controllerFuture == self.get()) controllerFuture = null;
                    }
                })
                .buildAsync();
            self.set(f);
            controllerFuture = f;
            f.addListener(() -> {
                try {
                    f.get();
                } catch (Throwable t) {
                    AppLog.w(TAG, "media session connection failed", t);
                    if (controllerFuture == f) controllerFuture = null;
                }
            }, ContextCompat.getMainExecutor(app));
        } catch (Throwable t) {
            AppLog.e(TAG, "could not connect to media service", t);
            controllerFuture = null;
        }
    }
}
