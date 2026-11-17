package es.alexcloudweb.nocturne.updates;

import android.content.Context;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * Periodic background check (WorkManager, ~every 6 h, network required): GET
 * {@code <serverUrl>/v1/updates/<channel>} (public, no auth) and notify once per newer version.
 * Runs with the app closed. Every failure (offline, 404, bad JSON) is swallowed: the next period retries.
 */
public class UpdateCheckWorker extends Worker {
    private static final String TAG = "NocturneUpdates";
    public static final String UNIQUE_NAME = "nocturne-update-check";
    static final long PERIOD_HOURS = 6;
    private static final int MAX_BODY = 64 * 1024;
    private static final int TIMEOUT_MS = 15_000;

    public UpdateCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** Enqueues (or updates in place, keeping its schedule) the unique periodic check. */
    public static void schedule(@NonNull Context ctx) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(UpdateCheckWorker.class, PERIOD_HOURS, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(ctx.getApplicationContext())
            .enqueueUniquePeriodicWork(UNIQUE_NAME, ExistingPeriodicWorkPolicy.UPDATE, req);
    }

    public static void cancel(@NonNull Context ctx) {
        WorkManager.getInstance(ctx.getApplicationContext()).cancelUniqueWork(UNIQUE_NAME);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            Context ctx = getApplicationContext();
            String server = UpdatePrefs.serverUrl(ctx);
            String channel = UpdatePrefs.channel(ctx);
            if (server == null || channel == null) return Result.success(); // signed out / not configured
            String version = fetchLatestVersion(server + "/v1/updates/" + channel);
            if (version != null) UpdateNotifier.notifyOnce(ctx, version);
        } catch (Throwable t) {
            Log.w(TAG, "background update check failed", t);
        }
        return Result.success();
    }

    /** The feed's {@code version}, or null on any network / HTTP / JSON problem. */
    @Nullable
    static String fetchLatestVersion(@NonNull String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setUseCaches(false);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() != 200) return null;
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream in = conn.getInputStream()) {
                byte[] chunk = new byte[4096];
                int n;
                while ((n = in.read(chunk)) != -1) {
                    if (buf.size() + n > MAX_BODY) return null;
                    buf.write(chunk, 0, n);
                }
            }
            return parseVersion(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        } catch (Throwable t) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    @Nullable
    static String parseVersion(@Nullable String body) {
        if (body == null) return null;
        try {
            Object v = new JSONObject(body).opt("version");
            if (!(v instanceof String)) return null;
            String s = ((String) v).trim();
            return UpdatePrefs.isValidVersion(s) ? s : null;
        } catch (Throwable t) {
            return null;
        }
    }
}
