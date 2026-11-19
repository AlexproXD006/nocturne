package es.alexcloudweb.nocturne.widget;

import androidx.annotation.Nullable;
import org.json.JSONException;
import org.json.JSONObject;

/** Per-widget appearance, stored per appWidgetId. Immutable; {@link #fromJson} sanitises everything. */
public final class WidgetConfig {
    public static final String MODE_ADAPTIVE = "adaptive";
    public static final String MODE_MATERIAL = "material_you";
    public static final String MODE_THEME = "theme";
    public static final String MODE_CUSTOM = "custom";

    /** Corner radius choices in dp: square, small, medium, large, round. */
    public static final int[] RADII_DP = {0, 10, 18, 28, 40};
    public static final int DEFAULT_RADIUS_INDEX = 2;

    public final String mode;
    public final String themeId;
    /** Opaque ARGB for MODE_CUSTOM. */
    public final int customColor;
    /** 0 = opaque … 100 = fully transparent background. */
    public final int transparency;
    public final int radiusIndex;

    public WidgetConfig(String mode, String themeId, int customColor, int transparency, int radiusIndex) {
        this.mode = isMode(mode) ? mode : MODE_ADAPTIVE;
        this.themeId = WidgetThemes.isKnown(themeId) ? themeId : WidgetThemes.APP;
        this.customColor = WidgetColors.opaque(customColor);
        this.transparency = Math.min(100, Math.max(0, transparency));
        this.radiusIndex = Math.min(RADII_DP.length - 1, Math.max(0, radiusIndex));
    }

    public static WidgetConfig defaults() {
        return new WidgetConfig(MODE_ADAPTIVE, WidgetThemes.APP, 0xFF1D2B4A, 8, DEFAULT_RADIUS_INDEX);
    }

    private static boolean isMode(@Nullable String m) {
        return MODE_ADAPTIVE.equals(m) || MODE_MATERIAL.equals(m) || MODE_THEME.equals(m) || MODE_CUSTOM.equals(m);
    }

    public int radiusDp() {
        return RADII_DP[radiusIndex];
    }

    /** Background alpha 0..255 for the transparency setting. */
    public int backgroundAlpha() {
        return (int) Math.round(255.0 * (100 - transparency) / 100.0);
    }

    public String toJson() {
        try {
            return new JSONObject()
                .put("mode", mode)
                .put("theme", themeId)
                .put("custom", WidgetColors.toHex(customColor))
                .put("transparency", transparency)
                .put("radius", radiusIndex)
                .toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    /** Never throws: malformed or missing JSON gives the defaults, bad fields are replaced one by one. */
    public static WidgetConfig fromJson(@Nullable String json) {
        WidgetConfig d = defaults();
        if (json == null || json.isEmpty()) return d;
        try {
            JSONObject o = new JSONObject(json);
            Integer custom = WidgetColors.parseHex(o.optString("custom", ""));
            return new WidgetConfig(
                o.optString("mode", d.mode),
                o.optString("theme", d.themeId),
                custom != null ? custom : d.customColor,
                o.optInt("transparency", d.transparency),
                o.optInt("radius", d.radiusIndex));
        } catch (JSONException e) {
            return d;
        }
    }

    private static String key(int appWidgetId) {
        return "config." + appWidgetId;
    }

    public static WidgetConfig load(KeyValueStore store, int appWidgetId) {
        return fromJson(store.get(key(appWidgetId)));
    }

    public static boolean exists(KeyValueStore store, int appWidgetId) {
        return store.get(key(appWidgetId)) != null;
    }

    public static void save(KeyValueStore store, int appWidgetId, WidgetConfig cfg) {
        store.put(key(appWidgetId), cfg.toJson());
    }

    public static void delete(KeyValueStore store, int appWidgetId) {
        store.remove(key(appWidgetId));
    }
}
