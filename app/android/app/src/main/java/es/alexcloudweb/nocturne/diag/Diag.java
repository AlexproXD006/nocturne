package es.alexcloudweb.nocturne.diag;

import android.content.Context;
import android.os.Build;
import java.io.File;
import org.json.JSONObject;

/** Process-wide crash reporter: installs the uncaught-exception handler and owns the report store and the log ring. */
public final class Diag {
    private static volatile CrashStore store;
    private static volatile RingLog ring;
    private static volatile String version = "";
    private static boolean installed;

    private Diag() {}

    public static synchronized void install(Context ctx) {
        if (installed) return;
        installed = true;
        try {
            Context app = ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
            File base = new File(app.getFilesDir(), "diag");
            store = new CrashStore(new File(base, "crashes"));
            ring = new RingLog(new File(base, "applog.txt"), 300);
            try {
                version = app.getPackageManager().getPackageInfo(app.getPackageName(), 0).versionName;
            } catch (Throwable ignored) {
                version = "";
            }
            final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
                try {
                    String trace = "Thread: " + (thread == null ? "?" : thread.getName()) + "\n" + CrashStore.stackOf(error);
                    record("native", trace);
                } catch (Throwable ignored) {
                    /* never mask the original crash */
                }
                if (prev != null) prev.uncaughtException(thread, error);
            });
        } catch (Throwable ignored) {
            /* reporter is best effort */
        }
    }

    public static boolean record(String kind, String trace) {
        CrashStore s = store;
        if (s == null) return false;
        return s.write(CrashStore.report(kind, version, "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")",
            Build.MANUFACTURER + " " + Build.MODEL, System.currentTimeMillis(), trace));
    }

    public static CrashStore store() {
        return store;
    }

    public static void log(String line) {
        RingLog r = ring;
        if (r != null) r.add(line);
    }

    public static String logSnapshot() {
        RingLog r = ring;
        return r == null ? "" : r.snapshot();
    }

    public static JSONObject device() {
        try {
            return new JSONObject().put("version", version).put("android", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")")
                .put("device", Build.MANUFACTURER + " " + Build.MODEL);
        } catch (Throwable t) {
            return new JSONObject();
        }
    }
}
