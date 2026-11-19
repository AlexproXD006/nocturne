package es.alexcloudweb.nocturne.widget;

import androidx.annotation.Nullable;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The app's current theme and accent as the WebView last reported them (NocturneMedia.setAppTheme),
 * kept natively so widgets can follow the app ("Like the app") with the app closed.
 */
public final class AppThemeStore {
    private static final String KEY = "appTheme";

    private AppThemeStore() {}

    public static final class State {
        /** Theme id (glass, dark, oled, adaptive, …). */
        public final String theme;
        /** "#rrggbb", or "" when the accent follows the cover. */
        public final String accent;

        public State(String theme, String accent) {
            this.theme = theme;
            this.accent = accent;
        }
    }

    public static State defaults() {
        return new State(WidgetThemes.GLASS, "");
    }

    public static String toJson(State s) {
        try {
            return new JSONObject().put("theme", s.theme).put("accent", s.accent).toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    /** Never throws; malformed input gives the defaults. */
    public static State fromJson(@Nullable String json) {
        if (json == null || json.isEmpty()) return defaults();
        try {
            JSONObject o = new JSONObject(json);
            String theme = o.optString("theme", WidgetThemes.GLASS);
            if (!WidgetThemes.isKnown(theme) && !WidgetThemes.ADAPTIVE.equals(theme)) theme = WidgetThemes.GLASS;
            String accent = o.optString("accent", "");
            return new State(theme, WidgetColors.parseHex(accent) == null ? "" : accent.trim());
        } catch (JSONException e) {
            return defaults();
        }
    }

    /** Sanitises what the WebView sent (theme id + optional "#rrggbb") into a state. */
    public static State sanitize(@Nullable String theme, @Nullable String accent) {
        String t = theme == null ? WidgetThemes.GLASS : theme.trim();
        if (!WidgetThemes.isKnown(t) && !WidgetThemes.ADAPTIVE.equals(t)) t = WidgetThemes.GLASS;
        Integer a = WidgetColors.parseHex(accent);
        return new State(t, a == null ? "" : WidgetColors.toHex(a));
    }

    public static State load(KeyValueStore store) {
        return fromJson(store.get(KEY));
    }

    public static void save(KeyValueStore store, State s) {
        store.put(KEY, toJson(s));
    }
}
