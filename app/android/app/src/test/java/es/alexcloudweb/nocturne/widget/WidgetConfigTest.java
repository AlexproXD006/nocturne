package es.alexcloudweb.nocturne.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import androidx.annotation.Nullable;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class WidgetConfigTest {
    private static final class MapStore implements KeyValueStore {
        final Map<String, String> m = new HashMap<>();

        @Nullable
        @Override
        public String get(String key) {
            return m.get(key);
        }

        @Override
        public void put(String key, String value) {
            m.put(key, value);
        }

        @Override
        public void remove(String key) {
            m.remove(key);
        }
    }

    @Test
    public void storesConfigPerWidgetId() {
        MapStore s = new MapStore();
        WidgetConfig a = new WidgetConfig(WidgetConfig.MODE_CUSTOM, "nord", 0xFF112233, 40, 4);
        WidgetConfig b = new WidgetConfig(WidgetConfig.MODE_THEME, "oled", 0xFF000000, 0, 0);
        WidgetConfig.save(s, 7, a);
        WidgetConfig.save(s, 8, b);
        WidgetConfig r = WidgetConfig.load(s, 7);
        assertEquals(WidgetConfig.MODE_CUSTOM, r.mode);
        assertEquals("nord", r.themeId);
        assertEquals(0xFF112233, r.customColor);
        assertEquals(40, r.transparency);
        assertEquals(4, r.radiusIndex);
        assertEquals("oled", WidgetConfig.load(s, 8).themeId);
        assertTrue(WidgetConfig.exists(s, 7));
    }

    @Test
    public void deleteForgetsOnlyThatWidget() {
        MapStore s = new MapStore();
        WidgetConfig.save(s, 1, WidgetConfig.defaults());
        WidgetConfig.save(s, 2, WidgetConfig.defaults());
        WidgetConfig.delete(s, 1);
        assertFalse(WidgetConfig.exists(s, 1));
        assertTrue(WidgetConfig.exists(s, 2));
    }

    @Test
    public void unknownWidgetGetsDefaults() {
        WidgetConfig d = WidgetConfig.load(new MapStore(), 99);
        assertEquals(WidgetConfig.MODE_ADAPTIVE, d.mode);
        assertEquals(WidgetConfig.DEFAULT_RADIUS_INDEX, d.radiusIndex);
    }

    @Test
    public void sanitisesBadValues() {
        WidgetConfig c = new WidgetConfig("bogus", "nope", 0x00123456, 250, 99);
        assertEquals(WidgetConfig.MODE_ADAPTIVE, c.mode);
        assertEquals(WidgetThemes.APP, c.themeId);
        assertEquals(0xFF123456, c.customColor);
        assertEquals(100, c.transparency);
        assertEquals(WidgetConfig.RADII_DP.length - 1, c.radiusIndex);
        assertEquals(0, new WidgetConfig("custom", "app", 0, -5, -1).transparency);
    }

    @Test
    public void malformedJsonGivesDefaults() {
        assertEquals(WidgetConfig.MODE_ADAPTIVE, WidgetConfig.fromJson("{not json").mode);
        assertEquals(WidgetConfig.MODE_ADAPTIVE, WidgetConfig.fromJson(null).mode);
        assertEquals(WidgetConfig.MODE_ADAPTIVE, WidgetConfig.fromJson("").mode);
        WidgetConfig partial = WidgetConfig.fromJson("{\"mode\":\"custom\",\"custom\":\"zzz\",\"transparency\":\"x\"}");
        assertEquals(WidgetConfig.MODE_CUSTOM, partial.mode);
        assertEquals(WidgetConfig.defaults().customColor, partial.customColor);
    }

    @Test
    public void backgroundAlphaFollowsTransparency() {
        assertEquals(255, new WidgetConfig("adaptive", "app", 0, 0, 2).backgroundAlpha());
        assertEquals(0, new WidgetConfig("adaptive", "app", 0, 100, 2).backgroundAlpha());
        assertEquals(128, new WidgetConfig("adaptive", "app", 0, 50, 2).backgroundAlpha());
        assertNotEquals(new WidgetConfig("adaptive", "app", 0, 10, 2).backgroundAlpha(), new WidgetConfig("adaptive", "app", 0, 20, 2).backgroundAlpha());
    }

    @Test
    public void radiusDpFollowsIndex() {
        assertEquals(0, new WidgetConfig("adaptive", "app", 0, 0, 0).radiusDp());
        assertEquals(40, new WidgetConfig("adaptive", "app", 0, 0, 4).radiusDp());
    }

    @Test
    public void appThemeIsStoredAndSanitised() {
        MapStore s = new MapStore();
        assertEquals("glass", AppThemeStore.load(s).theme);
        AppThemeStore.save(s, AppThemeStore.sanitize("tokyonight", "#7AA2F7"));
        AppThemeStore.State r = AppThemeStore.load(s);
        assertEquals("tokyonight", r.theme);
        assertEquals("#7aa2f7", r.accent);
        AppThemeStore.save(s, AppThemeStore.sanitize("adaptive", null));
        assertEquals("adaptive", AppThemeStore.load(s).theme);
        assertEquals("", AppThemeStore.load(s).accent);
        AppThemeStore.State bad = AppThemeStore.sanitize("<script>", "red");
        assertEquals("glass", bad.theme);
        assertEquals("", bad.accent);
        assertEquals("glass", AppThemeStore.fromJson("{bad").theme);
        assertNull(null);
    }

    @Test
    public void everyThemeIdTheAppCanSendIsKnown() {
        String[] appThemes = {"glass", "dark", "adaptive", "oled", "dim", "midnight", "dracula", "nord", "tokyonight", "catppuccin", "rosepine", "gruvbox"};
        for (String t : appThemes) assertEquals(t, AppThemeStore.sanitize(t, null).theme);
    }
}
