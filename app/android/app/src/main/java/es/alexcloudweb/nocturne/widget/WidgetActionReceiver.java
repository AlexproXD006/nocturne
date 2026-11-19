package es.alexcloudweb.nocturne.widget;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import es.alexcloudweb.nocturne.diag.AppLog;
import es.alexcloudweb.nocturne.media.WidgetBridge;

/** Widget buttons that are not media keys (the heart). Not exported: only our PendingIntents reach it. */
public final class WidgetActionReceiver extends BroadcastReceiver {
    static final String ACTION_LIKE = "es.alexcloudweb.nocturne.widget.LIKE";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (intent == null || !ACTION_LIKE.equals(intent.getAction())) return;
        final PendingResult pending = goAsync();
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            try {
                WidgetBridge.toggleLike(app);
            } catch (Throwable t) {
                AppLog.w("NocturneWidget", "like failed: " + t.getClass().getSimpleName());
            } finally {
                pending.finish();
            }
        }, "nocturne-widget-like").start();
    }
}
