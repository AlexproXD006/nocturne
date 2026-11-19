package es.alexcloudweb.nocturne.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.view.KeyEvent;
import android.widget.RemoteViews;
import androidx.annotation.Nullable;
import androidx.media3.session.MediaButtonReceiver;
import es.alexcloudweb.nocturne.MainActivity;
import es.alexcloudweb.nocturne.R;
import java.util.LinkedHashMap;
import java.util.Map;

/** Builds the RemoteViews of the three widgets: layout variants, colours, cover, texts and click targets. */
final class WidgetRenderer {
    /** Deep link the app turns into "open the fullscreen player" (see src/renderer/src/lib/widgetLink.ts). */
    static final String LINK_PLAYER = "es.alexcloudweb.nocturne://widget/player";
    static final String LINK_OPEN = "es.alexcloudweb.nocturne://widget/open";

    enum Kind { SMALL, MEDIUM, LARGE }

    /** One concrete layout. {@code minW/minH} (dp) are the smallest widget size it is chosen for. */
    enum Layout {
        SMALL_TINY(R.layout.widget_small_tiny, 0, 0, 32, false, false, false, false, false, false, false),
        SMALL(R.layout.widget_small, 100, 0, 40, false, true, false, false, false, false, false),
        MEDIUM_COMPACT(R.layout.widget_medium_compact, 0, 0, 44, true, true, true, false, false, false, false),
        MEDIUM(R.layout.widget_medium, 180, 95, 84, true, true, true, true, true, false, false),
        LARGE_COMPACT(R.layout.widget_large_compact, 0, 0, 96, true, true, true, true, true, true, false),
        LARGE(R.layout.widget_large, 180, 240, 120, true, true, true, true, true, true, true);

        final int res;
        final int minW;
        final int minH;
        final int coverDp;
        final boolean text;
        final boolean next;
        final boolean prev;
        final boolean like;
        final boolean progress;
        final boolean lyric;
        final boolean queue;

        Layout(int res, int minW, int minH, int coverDp, boolean text, boolean next, boolean prev, boolean like, boolean progress, boolean lyric, boolean queue) {
            this.res = res;
            this.minW = minW;
            this.minH = minH;
            this.coverDp = coverDp;
            this.text = text;
            this.next = next;
            this.prev = prev;
            this.like = like;
            this.progress = progress;
            this.lyric = lyric;
            this.queue = queue;
        }
    }

    private static final int[] BG_DRAWABLES = {
        R.drawable.widget_bg_r0, R.drawable.widget_bg_r1, R.drawable.widget_bg_r2, R.drawable.widget_bg_r3, R.drawable.widget_bg_r4
    };

    private WidgetRenderer() {}

    static Layout[] layoutsOf(Kind kind) {
        switch (kind) {
            case SMALL:
                return new Layout[] {Layout.SMALL_TINY, Layout.SMALL};
            case MEDIUM:
                return new Layout[] {Layout.MEDIUM_COMPACT, Layout.MEDIUM};
            default:
                return new Layout[] {Layout.LARGE_COMPACT, Layout.LARGE};
        }
    }

    /** The layout for a widget of {@code widthDp x heightDp} (0 = unknown: the richest one). */
    static Layout pick(Kind kind, int widthDp, int heightDp) {
        Layout[] all = layoutsOf(kind);
        if (widthDp <= 0 && heightDp <= 0) return all[all.length - 1];
        Layout best = all[0];
        for (Layout l : all) if (widthDp >= l.minW && heightDp >= l.minH) best = l;
        return best;
    }

    /** What to put in the launcher for {@code appWidgetId}: size-keyed layouts on Android 12+, one chosen layout before. */
    static RemoteViews render(Context ctx, Kind kind, WidgetState st, WidgetConfig cfg, WidgetColors.Scheme sc, @Nullable Bitmap cover, @Nullable Bundle options) {
        if (Build.VERSION.SDK_INT >= 31) {
            Map<SizeF, RemoteViews> map = new LinkedHashMap<>();
            for (Layout l : layoutsOf(kind)) map.put(new SizeF(l.minW, l.minH), renderLayout(ctx, l, st, cfg, sc, cover));
            return new RemoteViews(map);
        }
        int w = options == null ? 0 : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        int h = options == null ? 0 : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        return renderLayout(ctx, pick(kind, w, h), st, cfg, sc, cover);
    }

    static RemoteViews renderLayout(Context ctx, Layout l, WidgetState st, WidgetConfig cfg, WidgetColors.Scheme sc, @Nullable Bitmap cover) {
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), l.res);
        float density = ctx.getResources().getDisplayMetrics().density;

        // Background: a white rounded shape, tinted and made translucent.
        rv.setImageViewResource(R.id.w_bg, BG_DRAWABLES[cfg.radiusIndex]);
        rv.setInt(R.id.w_bg, "setColorFilter", WidgetColors.opaque(sc.bg));
        rv.setInt(R.id.w_bg, "setImageAlpha", cfg.backgroundAlpha());

        // Cover.
        if (cover != null) {
            int px = Math.round(l.coverDp * density);
            float frac = Math.min(0.5f, Math.max(0.06f, cfg.radiusDp() * 0.5f / l.coverDp));
            rv.setImageViewBitmap(R.id.w_cover, CoverLoader.rounded(cover, px, frac));
        } else {
            rv.setImageViewResource(R.id.w_cover, R.drawable.widget_cover_placeholder);
        }
        rv.setContentDescription(R.id.w_cover, ctx.getString(R.string.widget_cd_cover));

        boolean has = st.hasQueue;
        if (l.text) {
            rv.setTextViewText(R.id.w_title, has ? st.title : ctx.getString(R.string.widget_nothing_playing));
            rv.setTextViewText(R.id.w_artist, has ? st.artist : ctx.getString(R.string.widget_tap_to_open));
            rv.setTextColor(R.id.w_title, sc.onBg);
            rv.setTextColor(R.id.w_artist, sc.onBgMuted);
        }

        // Transport.
        rv.setImageViewResource(R.id.w_play, st.playing ? R.drawable.ic_widget_pause : R.drawable.ic_widget_play);
        rv.setInt(R.id.w_play, "setColorFilter", sc.onBg);
        rv.setContentDescription(R.id.w_play, ctx.getString(st.playing ? R.string.widget_cd_pause : R.string.widget_cd_play));
        rv.setOnClickPendingIntent(R.id.w_play, has ? mediaKey(ctx, st.playing ? KeyEvent.KEYCODE_MEDIA_PAUSE : KeyEvent.KEYCODE_MEDIA_PLAY) : openApp(ctx, false));
        if (l.next) {
            rv.setInt(R.id.w_next, "setColorFilter", sc.onBg);
            rv.setContentDescription(R.id.w_next, ctx.getString(R.string.widget_cd_next));
            rv.setOnClickPendingIntent(R.id.w_next, has ? mediaKey(ctx, KeyEvent.KEYCODE_MEDIA_NEXT) : openApp(ctx, false));
        }
        if (l.prev) {
            rv.setInt(R.id.w_prev, "setColorFilter", sc.onBg);
            rv.setContentDescription(R.id.w_prev, ctx.getString(R.string.widget_cd_prev));
            rv.setOnClickPendingIntent(R.id.w_prev, has ? mediaKey(ctx, KeyEvent.KEYCODE_MEDIA_PREVIOUS) : openApp(ctx, false));
        }
        if (l.like) {
            rv.setImageViewResource(R.id.w_like, st.liked ? R.drawable.ic_widget_heart_filled : R.drawable.ic_widget_heart);
            rv.setInt(R.id.w_like, "setColorFilter", st.liked ? sc.accent : sc.onBg);
            rv.setContentDescription(R.id.w_like, ctx.getString(st.liked ? R.string.widget_cd_unlike : R.string.widget_cd_like));
            rv.setOnClickPendingIntent(R.id.w_like, has ? likeIntent(ctx) : openApp(ctx, false));
        }

        if (l.progress) applyProgress(rv, st, sc);
        if (l.lyric) {
            rv.setTextViewText(R.id.w_lyric, lyricText(st));
            rv.setTextColor(R.id.w_lyric, sc.onBg);
        }
        if (l.queue) {
            boolean any = has && !st.upNext.isEmpty();
            rv.setViewVisibility(R.id.w_queue_label, any ? android.view.View.VISIBLE : android.view.View.GONE);
            rv.setTextViewText(R.id.w_queue_label, ctx.getString(R.string.widget_up_next));
            rv.setTextColor(R.id.w_queue_label, sc.accent);
            int[] ids = {R.id.w_q1, R.id.w_q2, R.id.w_q3};
            for (int i = 0; i < ids.length; i++) {
                boolean show = has && i < st.upNext.size();
                rv.setViewVisibility(ids[i], show ? android.view.View.VISIBLE : android.view.View.GONE);
                if (show) {
                    rv.setTextViewText(ids[i], (i + 1) + "  " + st.upNext.get(i));
                    rv.setTextColor(ids[i], sc.onBgMuted);
                }
            }
        }

        // Whole widget and cover open the app on the fullscreen player.
        PendingIntent open = openApp(ctx, has);
        rv.setOnClickPendingIntent(R.id.w_root, open);
        rv.setOnClickPendingIntent(R.id.w_cover, open);
        if (l.text) {
            rv.setOnClickPendingIntent(R.id.w_title, open);
            rv.setOnClickPendingIntent(R.id.w_artist, open);
        }
        return rv;
    }

    private static String lyricText(WidgetState st) {
        if (!st.hasQueue) return "";
        return st.lyric.isEmpty() ? "♪" : st.lyric;
    }

    private static void applyProgress(RemoteViews rv, WidgetState st, WidgetColors.Scheme sc) {
        int p = st.progress(1000);
        rv.setProgressBar(R.id.w_progress, 1000, p, false);
        rv.setProgressBar(R.id.w_progress_dark, 1000, p, false);
        if (Build.VERSION.SDK_INT >= 31) {
            rv.setColorStateList(R.id.w_progress, "setProgressTintList", ColorStateList.valueOf(sc.accent));
            rv.setColorStateList(R.id.w_progress, "setProgressBackgroundTintList", ColorStateList.valueOf(WidgetColors.withAlpha(sc.onBg, 70)));
            rv.setViewVisibility(R.id.w_progress_dark, android.view.View.GONE);
        } else {
            boolean darkText = WidgetColors.luminance(sc.onBg) < 0.4;
            rv.setViewVisibility(R.id.w_progress, darkText ? android.view.View.GONE : android.view.View.VISIBLE);
            rv.setViewVisibility(R.id.w_progress_dark, darkText ? android.view.View.VISIBLE : android.view.View.GONE);
        }
    }

    /** The live part of the large widget: progress and the current lyric line (partial update). */
    static RemoteViews tick(Context ctx, WidgetState st) {
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_large);
        int p = st.progress(1000);
        rv.setProgressBar(R.id.w_progress, 1000, p, false);
        rv.setProgressBar(R.id.w_progress_dark, 1000, p, false);
        rv.setTextViewText(R.id.w_lyric, lyricText(st));
        return rv;
    }

    // ---------------------------------------------------------------------------------------------
    // Click targets
    // ---------------------------------------------------------------------------------------------

    private static final int FLAGS = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;

    /** A media key sent to Media3's MediaButtonReceiver: works with the app closed (a play key restores the saved session). */
    private static PendingIntent mediaKey(Context ctx, int keyCode) {
        Intent i = new Intent(Intent.ACTION_MEDIA_BUTTON)
            .setComponent(new ComponentName(ctx, MediaButtonReceiver.class))
            .putExtra(Intent.EXTRA_KEY_EVENT, new KeyEvent(KeyEvent.ACTION_DOWN, keyCode));
        return PendingIntent.getBroadcast(ctx, 7000 + keyCode, i, FLAGS);
    }

    private static PendingIntent likeIntent(Context ctx) {
        Intent i = new Intent(WidgetActionReceiver.ACTION_LIKE).setComponent(new ComponentName(ctx, WidgetActionReceiver.class));
        return PendingIntent.getBroadcast(ctx, 7100, i, FLAGS);
    }

    static PendingIntent openApp(Context ctx, boolean player) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(player ? LINK_PLAYER : LINK_OPEN))
            .setComponent(new ComponentName(ctx, MainActivity.class))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        return PendingIntent.getActivity(ctx, player ? 7201 : 7200, i, FLAGS);
    }
}
