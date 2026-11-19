package es.alexcloudweb.nocturne.media;

import android.content.Context;
import android.content.SharedPreferences;
import es.alexcloudweb.nocturne.diag.AppLog;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Durable play reports. The service reports every counted listen itself (the WebView may be dead): each
 * listen is stored with a client generated {@code playId} (the server ignores a play id it already has,
 * so retries never double count) and sent in the background; what could not be sent stays for the next try.
 */
final class PlayReporter {
    private static final String TAG = "NocturnePlays";
    private static final String PREFS = "nocturne_native_plays";
    private static final String FIELD = "pending";
    private static final int MAX_PENDING = 200;
    private static final long MAX_AGE_MS = 14L * 24 * 3600_000;

    private final Context app;
    private final NocturneApi api;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    PlayReporter(Context app, NocturneApi api) {
        this.app = app.getApplicationContext();
        this.api = api;
    }

    void report(ListenTracker.Listen l) {
        try {
            JSONObject e = new JSONObject()
                .put("playId", UUID.randomUUID().toString())
                .put("trackId", l.trackId)
                .put("seconds", l.seconds)
                .put("at", iso(l.startedAtMs))
                .put("savedAt", System.currentTimeMillis());
            synchronized (this) {
                JSONArray list = read();
                list.put(e);
                write(trim(list));
            }
        } catch (Throwable t) {
            AppLog.w(TAG, "could not store play", t);
        }
        flush();
    }

    void flush() {
        io.execute(() -> {
            try {
                for (;;) {
                    JSONObject first;
                    synchronized (this) {
                        JSONArray list = read();
                        if (list.length() == 0) return;
                        first = list.optJSONObject(0);
                    }
                    if (first == null) {
                        drop(null);
                        continue;
                    }
                    JSONObject body = new JSONObject()
                        .put("playedSeconds", first.optLong("seconds"))
                        .put("at", first.optString("at"))
                        .put("playId", first.optString("playId"));
                    try {
                        api.request("POST", "/v1/tracks/" + NocturneApi.pathId(first.optString("trackId")) + "/played", body);
                        drop(first);
                    } catch (NocturneApi.HttpException e) {
                        if (e.status == 429 || e.status >= 500) return; // try again later
                        drop(first); // the server will never take it (unknown track, scrobbling off, ...)
                    } catch (IOException e) {
                        return; // offline or signed out: keep it
                    }
                }
            } catch (Throwable t) {
                AppLog.w(TAG, "flush failed", t);
            }
        });
    }

    private synchronized void drop(JSONObject entry) {
        JSONArray list = read();
        JSONArray out = new JSONArray();
        boolean removed = false;
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            if (!removed && (entry == null ? o == null : o != null && o.optString("playId").equals(entry.optString("playId")))) {
                removed = true;
                continue;
            }
            out.put(o);
        }
        write(out);
    }

    private JSONArray trim(JSONArray list) {
        long now = System.currentTimeMillis();
        JSONArray out = new JSONArray();
        int start = Math.max(0, list.length() - MAX_PENDING);
        for (int i = start; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            if (o != null && now - o.optLong("savedAt", now) < MAX_AGE_MS) out.put(o);
        }
        return out;
    }

    private JSONArray read() {
        try {
            return new JSONArray(prefs().getString(FIELD, "[]"));
        } catch (Throwable t) {
            return new JSONArray();
        }
    }

    private void write(JSONArray list) {
        prefs().edit().putString(FIELD, list.toString()).apply();
    }

    private SharedPreferences prefs() {
        return app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }
}
