package es.alexcloudweb.nocturne.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.os.Bundle;

/** Shared behaviour of the three widget providers. */
public abstract class NocturneWidgetProvider extends AppWidgetProvider {
    abstract WidgetRenderer.Kind kind();

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        final BroadcastReceiver.PendingResult pending = goAsync();
        WidgetUpdater u = WidgetUpdater.get(ctx);
        u.refresh(kind(), ids, pending::finish);
        u.widgetsChanged();
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle newOptions) {
        final BroadcastReceiver.PendingResult pending = goAsync();
        WidgetUpdater.get(ctx).refresh(kind(), new int[] {id}, pending::finish);
    }

    @Override
    public void onDeleted(Context ctx, int[] ids) {
        KeyValueStore kv = KeyValueStore.prefs(ctx);
        for (int id : ids) WidgetConfig.delete(kv, id);
        WidgetUpdater.get(ctx).widgetsChanged();
    }

    @Override
    public void onEnabled(Context ctx) {
        WidgetUpdater.get(ctx).widgetsChanged();
    }

    @Override
    public void onDisabled(Context ctx) {
        WidgetUpdater.get(ctx).widgetsChanged();
    }
}
