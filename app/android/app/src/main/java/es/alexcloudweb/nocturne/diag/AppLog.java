package es.alexcloudweb.nocturne.diag;

import android.util.Log;

/** android.util.Log that also feeds the scrubbed in-app ring buffer sent by "Send diagnostic report". Never throws. */
public final class AppLog {
    private AppLog() {}

    private static void feed(String level, String tag, String msg, Throwable t) {
        try {
            Diag.log(level + "/" + tag + ": " + msg + (t == null ? "" : " [" + t.getClass().getSimpleName() + ": " + t.getMessage() + "]"));
        } catch (Throwable ignored) {
            /* ignore */
        }
    }

    public static int d(String tag, String msg) { feed("D", tag, msg, null); try { return Log.d(tag, msg); } catch (Throwable e) { return 0; } }
    public static int i(String tag, String msg) { feed("I", tag, msg, null); try { return Log.i(tag, msg); } catch (Throwable e) { return 0; } }
    public static int w(String tag, String msg) { feed("W", tag, msg, null); try { return Log.w(tag, msg); } catch (Throwable e) { return 0; } }
    public static int w(String tag, String msg, Throwable t) { feed("W", tag, msg, t); try { return Log.w(tag, msg, t); } catch (Throwable e) { return 0; } }
    public static int e(String tag, String msg) { feed("E", tag, msg, null); try { return Log.e(tag, msg); } catch (Throwable e) { return 0; } }
    public static int e(String tag, String msg, Throwable t) { feed("E", tag, msg, t); try { return Log.e(tag, msg, t); } catch (Throwable e) { return 0; } }
}
