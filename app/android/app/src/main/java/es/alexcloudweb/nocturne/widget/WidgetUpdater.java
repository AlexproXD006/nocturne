package es.alexcloudweb.nocturne.widget;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.widget.RemoteViews;
import androidx.annotation.Nullable;
import es.alexcloudweb.nocturne.media.WidgetBridge;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Pushes the playback state to the home-screen widgets. All work (cover download, Palette, rendering,
 * binder calls) runs on one background thread; the media service only hands over immutable
 * {@link WidgetState}s. Full updates rebuild every widget; {@link #pushTick} partially updates the large
 * widget's progress and lyric line, throttled by {@link WidgetThrottle}.
 */
public final class WidgetUpdater {
    private static final String TAG = "NocturneWidget";
    private static WidgetUpdater instance;

    public static synchronized WidgetUpdater get(Context ctx) {
        if (instance == null) instance = new WidgetUpdater(ctx.getApplicationContext());
        return instance;
    }

    private final Context app;
    private final ExecutorService exec = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "nocturne-widgets");
        t.setDaemon(true);
        return t;
    });
    private final WidgetThrottle throttle = new WidgetThrottle();
    @Nullable private volatile WidgetState last;
    private volatile int[] largeIds = new int[0];
    private volatile boolean idsLoaded;

    private WidgetUpdater(Context app) {
        this.app = app;
    }

    // ---------------------------------------------------------------------------------------------
    // Called by the media service (any thread)
    // ---------------------------------------------------------------------------------------------

    /** Track change, play/pause, like, queue: rebuild every widget. */
    public void pushFull(WidgetState st) {
        last = st;
        throttle.reset();
        exec.execute(() -> renderAll(st));
    }

    /** Playback tick: progress + lyric of the large widget only, while playing, at most about once a second. */
    public void pushTick(WidgetState st, int lyricIdx) {
        last = st;
        if (!throttle.shouldPush(System.currentTimeMillis(), st.playing, hasLarge(), st.positionMs, lyricIdx)) return;
        exec.execute(() -> {
            try {
                int[] ids = largeIds;
                if (ids.length == 0) return;
                AppWidgetManager mgr = AppWidgetManager.getInstance(app);
                RemoteViews rv = WidgetRenderer.tick(app, st);
                for (int id : ids) {
                    if (Build.VERSION.SDK_INT >= 26) mgr.partiallyUpdateAppWidget(id, rv);
                    else mgr.updateAppWidget(id, rv);
                }
            } catch (Throwable t) {
                Log.w(TAG, "tick failed: " + t.getClass().getSimpleName());
            }
        });
    }

    /** Whether a large (lyrics) widget is on a home screen. Cached; refreshed by every update. */
    public boolean hasLarge() {
        if (!idsLoaded) exec.execute(this::loadIds);
        return largeIds.length > 0;
    }

    // ---------------------------------------------------------------------------------------------
    // Called by the providers and the configuration screen
    // ---------------------------------------------------------------------------------------------

    /** (Re)draws the given widgets of one kind now, with the freshest state we have. */
    void refresh(WidgetRenderer.Kind kind, int[] ids, @Nullable Runnable done) {
        exec.execute(() -> {
            try {
                loadIds();
                renderKind(kind, ids, state());
            } finally {
                if (done != null) done.run();
            }
        });
    }

    /** Redraws every widget (theme from the app changed, widget added/removed/reconfigured). */
    public void refreshAll() {
        exec.execute(() -> {
            loadIds();
            renderAll(state());
        });
    }

    /** A widget was added or removed: re-count them and let the service load lyrics if needed. */
    void widgetsChanged() {
        exec.execute(() -> {
            loadIds();
            WidgetBridge.widgetsChanged();
        });
    }

    /** The latest state (what the service pushed, else the saved session). */
    WidgetState state() {
        WidgetState s = last;
        return s != null ? s : WidgetBridge.savedState(app);
    }

    @Nullable
    public WidgetState lastPushed() {
        return last;
    }

    // ---------------------------------------------------------------------------------------------

    private void loadIds() {
        try {
            largeIds = AppWidgetManager.getInstance(app).getAppWidgetIds(new ComponentName(app, LargeWidgetProvider.class));
            idsLoaded = true;
        } catch (Throwable t) {
            Log.w(TAG, "widget ids unavailable");
        }
    }

    private void renderAll(WidgetState st) {
        loadIds();
        AppWidgetManager mgr = AppWidgetManager.getInstance(app);
        for (WidgetRenderer.Kind k : WidgetRenderer.Kind.values()) {
            renderKind(k, mgr.getAppWidgetIds(new ComponentName(app, providerOf(k))), st);
        }
    }

    static Class<?> providerOf(WidgetRenderer.Kind k) {
        switch (k) {
            case SMALL:
                return SmallWidgetProvider.class;
            case MEDIUM:
                return MediumWidgetProvider.class;
            default:
                return LargeWidgetProvider.class;
        }
    }

    private void renderKind(WidgetRenderer.Kind kind, int[] ids, WidgetState st) {
        if (ids == null || ids.length == 0) return;
        AppWidgetManager mgr = AppWidgetManager.getInstance(app);
        Bitmap cover = st.hasQueue ? CoverLoader.load(app, st.trackId, st.artUrl) : null;
        int[] palette = cover != null ? CoverLoader.palette(st.trackId, cover) : null;
        KeyValueStore kv = KeyValueStore.prefs(app);
        AppThemeStore.State appTheme = AppThemeStore.load(kv);
        int[] system = systemColors(app);
        for (int id : ids) {
            try {
                WidgetConfig cfg = WidgetConfig.load(kv, id);
                WidgetColors.Scheme sc = WidgetColors.resolve(cfg, appTheme, palette, system);
                Bundle options = mgr.getAppWidgetOptions(id);
                mgr.updateAppWidget(id, WidgetRenderer.render(app, kind, st, cfg, sc, cover, options));
            } catch (Throwable t) {
                Log.w(TAG, "widget " + id + " not updated: " + t.getClass().getSimpleName());
            }
        }
    }

    /** {background, text, accent} from Android 12+'s dynamic colours, or null. */
    @Nullable
    static int[] systemColors(Context ctx) {
        if (Build.VERSION.SDK_INT < 31) return null;
        try {
            boolean night = (ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
            if (night) {
                return new int[] {ctx.getColor(android.R.color.system_neutral1_900), ctx.getColor(android.R.color.system_neutral1_100), ctx.getColor(android.R.color.system_accent1_200)};
            }
            return new int[] {ctx.getColor(android.R.color.system_neutral1_50), ctx.getColor(android.R.color.system_neutral1_900), ctx.getColor(android.R.color.system_accent1_600)};
        } catch (Throwable t) {
            return null;
        }
    }
}
