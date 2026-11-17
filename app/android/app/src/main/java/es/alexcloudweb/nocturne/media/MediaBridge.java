package es.alexcloudweb.nocturne.media;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.MainThread;
import androidx.annotation.Nullable;

/**
 * In-process hub between the Capacitor plugin (JS side) and {@link NocturneMediaService}.
 *
 * <ul>
 *   <li>State in: the plugin pushes {@link NowPlayingState} snapshots; the service (if alive) is told
 *       to refresh its player and buttons. A service created later reads {@link #current()}.
 *   <li>Commands out: the bridge player calls {@link #dispatch}, which forwards to the plugin's
 *       sink, which emits the JS {@code command} event. No sink (WebView gone) = dropped.
 * </ul>
 *
 * <p>All state access happens on the main thread (the Media3 player's application looper).
 */
final class MediaBridge {
    private static final String TAG = "NocturneMedia";

    interface CommandSink {
        void onCommand(String kind, @Nullable Double positionSeconds);
    }

    interface StateListener {
        @MainThread
        void onStateChanged(@Nullable NowPlayingState state);
    }

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    @Nullable private static NowPlayingState state;
    @Nullable private static volatile CommandSink sink;
    @Nullable private static StateListener listener;

    private MediaBridge() {}

    /** Runs on the main thread (immediately if already there); never lets an exception escape. */
    static void runOnMain(Runnable r) {
        Runnable safe = () -> {
            try {
                r.run();
            } catch (Throwable t) {
                Log.e(TAG, "media bridge task failed", t);
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) safe.run();
        else MAIN.post(safe);
    }

    @MainThread
    @Nullable
    static NowPlayingState current() {
        return state;
    }

    /** Replaces the snapshot (null = nothing playing) and tells the service. */
    @MainThread
    static void setState(@Nullable NowPlayingState next) {
        state = next;
        StateListener l = listener;
        if (l != null) {
            try {
                l.onStateChanged(next);
            } catch (Throwable t) {
                Log.e(TAG, "media service refresh failed", t);
            }
        }
    }

    /**
     * Optimistic local update made by the player in response to a system command (e.g. pause from
     * the notification) so the UI reacts at once; JS sends the authoritative state right after.
     * The player re-reads the state itself, so the listener is not notified unless asked.
     */
    @MainThread
    static void setStateQuietly(@Nullable NowPlayingState next) {
        state = next;
    }

    /** Like {@link #setState} but tells the service on the next main-loop turn (safe inside player callbacks). */
    @MainThread
    static void setStateDeferred(@Nullable NowPlayingState next) {
        state = next;
        MAIN.post(() -> {
            try {
                StateListener l = listener;
                if (l != null) l.onStateChanged(state);
            } catch (Throwable t) {
                Log.e(TAG, "media service refresh failed", t);
            }
        });
    }

    @MainThread
    static void attach(StateListener l) {
        listener = l;
    }

    @MainThread
    static void detach(StateListener l) {
        if (listener == l) listener = null;
    }

    static void setCommandSink(@Nullable CommandSink s) {
        sink = s;
    }

    /** Forwards a user command (notification, lock screen, Bluetooth, Now Bar) to JS. */
    static void dispatch(String kind, @Nullable Double positionSeconds) {
        CommandSink s = sink;
        if (s == null) {
            Log.w(TAG, "command '" + kind + "' dropped: no WebView listener");
            return;
        }
        try {
            s.onCommand(kind, positionSeconds);
        } catch (Throwable t) {
            Log.e(TAG, "command dispatch failed", t);
        }
    }
}
