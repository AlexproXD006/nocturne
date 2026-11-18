package es.alexcloudweb.nocturne.media;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Last equalizer state sent by the WebView, kept natively so the service applies it on a cold start
 * (app closed, Android Auto) before any JS runs. Format: {@code {"enabled":true,"preamp":-3,"gains":[10 numbers]}}.
 */
final class EqPrefs {
    private static final String PREFS = "nocturne_native_prefs";
    private static final String KEY = "eq";

    private EqPrefs() {}

    /** Plain value object; values are clamped to the supported ranges. */
    static final class State {
        final boolean enabled;
        final double preampDb;
        final double[] gains;

        State(boolean enabled, double preampDb, double[] gains) {
            this.enabled = enabled;
            this.preampDb = EqDsp.clamp(preampDb, EqDsp.PREAMP_MIN, EqDsp.PREAMP_MAX);
            double[] g = new double[EqDsp.BANDS];
            for (int i = 0; i < g.length; i++) g[i] = gains != null && i < gains.length ? EqDsp.clamp(gains[i], EqDsp.GAIN_MIN, EqDsp.GAIN_MAX) : 0;
            this.gains = g;
        }

        static State flat() {
            return new State(false, 0, null);
        }

        JSONObject toJson() {
            try {
                JSONArray a = new JSONArray();
                for (double g : gains) a.put(g);
                return new JSONObject().put("enabled", enabled).put("preamp", preampDb).put("gains", a);
            } catch (JSONException e) {
                throw new IllegalStateException(e);
            }
        }

        static State fromJson(JSONObject o) {
            if (o == null) return flat();
            JSONArray a = o.optJSONArray("gains");
            double[] g = new double[EqDsp.BANDS];
            for (int i = 0; i < g.length; i++) g[i] = a == null ? 0 : a.optDouble(i, 0);
            return new State(o.optBoolean("enabled", false), o.optDouble("preamp", 0), g);
        }
    }

    static State parse(String json) {
        if (json == null || json.isEmpty()) return State.flat();
        try {
            return State.fromJson(new JSONObject(json));
        } catch (JSONException e) {
            return State.flat();
        }
    }

    static void save(Context ctx, State s) {
        if (ctx != null) ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, s.toJson().toString()).apply();
    }

    static State load(Context ctx) {
        return ctx == null ? State.flat() : parse(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null));
    }
}
