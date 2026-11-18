package es.alexcloudweb.nocturne.media;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * In-process hub between the Capacitor plugin (WebView) and {@link NocturneMediaService}.
 *
 * <ul>
 *   <li>Commands in: run on the service once it exists (queued until then, in order).
 *   <li>Events out: the service emits JSON events; with no sink (WebView gone) they are dropped, and
 *       {@link #hasSink()} tells the service to handle UI-bound buttons (shuffle, repeat) itself.
 * </ul>
 */
final class EventHub {
    private static final String TAG = "NocturneMedia";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    interface Sink {
        void emit(JSONObject event);
    }

    @Nullable private static volatile Sink sink;
    @Nullable private static NocturneMediaService service;
    private static final List<Consumer<NocturneMediaService>> pending = new ArrayList<>();

    private EventHub() {}

    static void runOnMain(Runnable r) {
        Runnable safe = () -> {
            try {
                r.run();
            } catch (Throwable t) {
                Log.e(TAG, "media task failed", t);
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) safe.run();
        else MAIN.post(safe);
    }

    static void setSink(@Nullable Sink s) {
        sink = s;
    }

    static boolean hasSink() {
        return sink != null;
    }

    static void emit(JSONObject event) {
        Sink s = sink;
        if (s == null) return;
        try {
            s.emit(event);
        } catch (Throwable t) {
            Log.e(TAG, "event dispatch failed", t);
        }
    }

    /** Runs {@code c} on the main thread with the service; queued until the service is created. */
    static void withService(Consumer<NocturneMediaService> c) {
        runOnMain(() -> {
            if (service != null) c.accept(service);
            else pending.add(c);
        });
    }

    static boolean serviceAlive() {
        return service != null;
    }

    static void attach(NocturneMediaService s) {
        runOnMain(() -> {
            service = s;
            List<Consumer<NocturneMediaService>> run = new ArrayList<>(pending);
            pending.clear();
            for (Consumer<NocturneMediaService> c : run) {
                try {
                    c.accept(s);
                } catch (Throwable t) {
                    Log.e(TAG, "queued media task failed", t);
                }
            }
        });
    }

    static void detach(NocturneMediaService s) {
        runOnMain(() -> {
            if (service == s) service = null;
        });
    }

    static void dropPending() {
        runOnMain(pending::clear);
    }
}
