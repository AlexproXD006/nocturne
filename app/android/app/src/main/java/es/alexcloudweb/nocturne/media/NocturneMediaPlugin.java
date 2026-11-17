package es.alexcloudweb.nocturne.media;

import android.content.ComponentName;
import android.content.Context;
import android.os.Looper;
import android.util.Log;
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
import java.util.concurrent.atomic.AtomicReference;

/**
 * JS API ({@code registerPlugin('NocturneMedia')}):
 * <ul>
 *   <li>{@code update(info)}: now-playing snapshot (seconds, see NowPlayingInfo in platform/index.ts).
 *   <li>{@code clear()}: nothing is playing any more; removes the system controls.
 *   <li>event {@code command}: {@code { kind, position? }} with kind one of play, pause, next,
 *       previous, stop, seekTo (position in seconds), like, shuffle, repeat.
 * </ul>
 *
 * <p>The plugin keeps a {@link MediaController} connected to {@link NocturneMediaService} while
 * something is loaded. That binding creates the service (from the foreground app, which keeps
 * Android 14+ happy) and keeps it alive while paused; Media3 promotes it to a foreground service
 * itself once playback starts.
 */
@CapacitorPlugin(name = "NocturneMedia")
public class NocturneMediaPlugin extends Plugin {
    private static final String TAG = "NocturneMedia";

    @Nullable private ListenableFuture<MediaController> controllerFuture;

    @Override
    public void load() {
        MediaBridge.setCommandSink(this::emitCommand);
    }

    @PluginMethod
    public void update(PluginCall call) {
        final NowPlayingState state = NowPlayingState.fromJson(call.getData());
        MediaBridge.runOnMain(() -> {
            MediaBridge.setState(state);
            if (state != null) ensureConnected();
        });
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        MediaBridge.runOnMain(this::clearOnMain);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        // The activity (and with it the WebView that produces the audio) is going away.
        MediaBridge.setCommandSink(null);
        MediaBridge.runOnMain(this::clearOnMain);
        super.handleOnDestroy();
    }

    private void emitCommand(String kind, @Nullable Double positionSeconds) {
        JSObject data = new JSObject();
        data.put("kind", kind);
        if (positionSeconds != null && !positionSeconds.isNaN() && !positionSeconds.isInfinite()) {
            data.put("position", positionSeconds.doubleValue());
        }
        notifyListeners("command", data);
    }

    @MainThread
    private void clearOnMain() {
        MediaBridge.setState(null);
        ListenableFuture<MediaController> f = controllerFuture;
        controllerFuture = null;
        if (f != null) {
            try {
                MediaController.releaseFuture(f);
            } catch (Throwable t) {
                Log.w(TAG, "controller release failed", t);
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
                        // Service died or was stopped: reconnect on the next update().
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
                    Log.w(TAG, "media session connection failed", t);
                    if (controllerFuture == f) controllerFuture = null;
                }
            }, ContextCompat.getMainExecutor(app));
        } catch (Throwable t) {
            Log.e(TAG, "could not connect to media service", t);
            controllerFuture = null;
        }
    }
}
