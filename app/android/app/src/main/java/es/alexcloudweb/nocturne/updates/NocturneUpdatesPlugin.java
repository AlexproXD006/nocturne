package es.alexcloudweb.nocturne.updates;

import android.app.Activity;
import android.content.Intent;
import es.alexcloudweb.nocturne.diag.AppLog;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS API ({@code registerPlugin('NocturneUpdates')}), see platform/nocturneUpdates.ts:
 * <ul>
 *   <li>{@code configure({ serverUrl, channel })}: remember the feed and schedule the periodic
 *       background check (unique work, UPDATE policy: re-configuring keeps the schedule).
 *   <li>{@code clear()}: logout; cancels the work, forgets the feed, removes a posted notification.
 *   <li>{@code notify({ version })} → {@code { posted }}: foreground check found an update; posts the
 *       same notification once per version (shared dedupe with the worker).
 *   <li>event {@code updateTapped} {@code { version }}: the app was opened from the notification
 *       (retained until a listener is attached, so a cold start is not missed).
 * </ul>
 */
@CapacitorPlugin(name = "NocturneUpdates")
public class NocturneUpdatesPlugin extends Plugin {
    private static final String TAG = "NocturneUpdates";

    @Override
    public void load() {
        try {
            Activity a = getActivity();
            if (a != null) deliverTap(a.getIntent());
        } catch (Throwable t) {
            AppLog.w(TAG, "launch intent check failed", t);
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        try {
            deliverTap(intent);
        } catch (Throwable t) {
            AppLog.w(TAG, "new intent check failed", t);
        }
    }

    private void deliverTap(@Nullable Intent intent) {
        if (intent == null || !UpdateNotifier.ACTION_SHOW_UPDATE.equals(intent.getAction())) return;
        String version = intent.getStringExtra(UpdateNotifier.EXTRA_VERSION);
        // Consume it so a later recreate doesn't replay the tap.
        intent.setAction(Intent.ACTION_MAIN);
        intent.removeExtra(UpdateNotifier.EXTRA_VERSION);
        JSObject data = new JSObject();
        data.put("version", UpdatePrefs.isValidVersion(version) ? version.trim() : "");
        notifyListeners("updateTapped", data, true);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        try {
            String server = UpdatePrefs.normaliseServerUrl(call.getString("serverUrl"));
            String channel = call.getString("channel");
            if (server == null || !UpdatePrefs.isValidChannel(channel)) {
                call.reject("invalid serverUrl or channel");
                return;
            }
            UpdatePrefs.save(getContext(), server, channel);
            UpdateCheckWorker.schedule(getContext());
            call.resolve();
        } catch (Throwable t) {
            AppLog.w(TAG, "configure failed", t);
            call.reject("configure failed");
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            UpdateCheckWorker.cancel(getContext());
            UpdatePrefs.clearTarget(getContext());
            UpdateNotifier.cancel(getContext());
        } catch (Throwable t) {
            AppLog.w(TAG, "clear failed", t);
        }
        call.resolve();
    }

    @PluginMethod
    public void notify(PluginCall call) {
        boolean posted = false;
        try {
            posted = UpdateNotifier.notifyOnce(getContext(), call.getString("version"));
        } catch (Throwable t) {
            AppLog.w(TAG, "notify failed", t);
        }
        JSObject res = new JSObject();
        res.put("posted", posted);
        call.resolve(res);
    }
}
