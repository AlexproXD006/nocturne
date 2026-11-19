package es.alexcloudweb.nocturne.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.os.Bundle;
import es.alexcloudweb.nocturne.diag.AppLog;

/**
 * Shared behaviour of the three widget providers. Every entry point is defensive: the launcher calls these
 * the instant a widget is dropped (including options-changed with whatever bundle One UI built), and an
 * exception here would kill the process.
 */
public abstract class NocturneWidgetProvider extends AppWidgetProvider {
    private static final String TAG = "NocturneWidget";

    abstract WidgetRenderer.Kind kind();

    private static void finishQuietly(BroadcastReceiver.PendingResult p) {
        if (p == null) return;
        try {
            p.finish();
        } catch (Throwable ignored) {
            /* already finished */
        }
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        BroadcastReceiver.PendingResult pending = null;
        try {
            pending = goAsync();
            final BroadcastReceiver.PendingResult p = pending;
            WidgetUpdater u = WidgetUpdater.get(ctx);
            u.refresh(kind(), ids == null ? new int[0] : ids, () -> finishQuietly(p));
            u.widgetsChanged();
        } catch (Throwable t) {
            AppLog.w(TAG, "onUpdate failed", t);
            finishQuietly(pending);
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle newOptions) {
        BroadcastReceiver.PendingResult pending = null;
        try {
            pending = goAsync();
            final BroadcastReceiver.PendingResult p = pending;
            WidgetUpdater.get(ctx).refresh(kind(), new int[] {id}, () -> finishQuietly(p));
        } catch (Throwable t) {
            AppLog.w(TAG, "onAppWidgetOptionsChanged failed", t);
            finishQuietly(pending);
        }
    }

    @Override
    public void onDeleted(Context ctx, int[] ids) {
        try {
            KeyValueStore kv = KeyValueStore.prefs(ctx);
            if (ids != null) for (int id : ids) WidgetConfig.delete(kv, id);
            WidgetUpdater.get(ctx).widgetsChanged();
        } catch (Throwable t) {
            AppLog.w(TAG, "onDeleted failed", t);
        }
    }

    @Override
    public void onEnabled(Context ctx) {
        try {
            WidgetUpdater.get(ctx).widgetsChanged();
        } catch (Throwable t) {
            AppLog.w(TAG, "onEnabled failed", t);
        }
    }

    @Override
    public void onDisabled(Context ctx) {
        try {
            WidgetUpdater.get(ctx).widgetsChanged();
        } catch (Throwable t) {
            AppLog.w(TAG, "onDisabled failed", t);
        }
    }

    @Override
    public void onReceive(Context ctx, android.content.Intent intent) {
        try {
            super.onReceive(ctx, intent);
        } catch (Throwable t) {
            AppLog.w(TAG, "widget broadcast failed", t);
        }
    }
}
