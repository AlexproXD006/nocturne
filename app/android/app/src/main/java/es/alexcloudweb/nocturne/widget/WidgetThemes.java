package es.alexcloudweb.nocturne.widget;

import androidx.annotation.Nullable;

/**
 * The app's interface themes as widget colour presets (surface = the theme's ink-900/950, text = --color-fg,
 * accent = the theme's usual accent). Mirrors THEMES in src/renderer/src/store/settings.ts and the theme
 * blocks of styles.css; tests/lib/widgetTheme.test.ts checks that every app theme id is present here.
 */
public final class WidgetThemes {
    public static final String GLASS = "glass";
    public static final String DARK = "dark";
    public static final String OLED = "oled";
    public static final String ADAPTIVE = "adaptive";
    /** "Like the app": the theme and accent the app reported through setAppTheme. */
    public static final String APP = "app";
    /** Midnight Glass base with the cover's accent. */
    public static final String COVER_ACCENT = "cover_accent";

    public static final class Theme {
        public final String id;
        final int bg;
        final int fg;
        final int accent;

        Theme(String id, int bg, int fg, int accent) {
            this.id = id;
            this.bg = 0xFF000000 | bg;
            this.fg = 0xFF000000 | fg;
            this.accent = 0xFF000000 | accent;
        }

        public WidgetColors.Scheme scheme(@Nullable Integer accentOverride) {
            return WidgetColors.fromBase(bg, fg, accentOverride != null ? accentOverride : accent);
        }
    }

    private static final Theme[] TABLE = {
        new Theme(GLASS, 0x0D1424, 0xEEF2FA, 0x8FB4FF),
        new Theme(DARK, 0x0E0E12, 0xF3F3F6, 0xFF7A5C),
        new Theme(OLED, 0x000000, 0xF3F3F6, 0xFF7A5C),
        new Theme("dim", 0x1A2735, 0xF0F3F5, 0x7AA2F7),
        new Theme("midnight", 0x0E1322, 0xEEF1F8, 0x7AA2F7),
        new Theme("dracula", 0x282A36, 0xF8F8F2, 0xBD93F9),
        new Theme("nord", 0x2E3440, 0xECEFF4, 0x88C0D0),
        new Theme("tokyonight", 0x1A1B26, 0xC0CAF5, 0x7AA2F7),
        new Theme("catppuccin", 0x1E1E2E, 0xCDD6F4, 0xCBA6F7),
        new Theme("rosepine", 0x191724, 0xE0DEF4, 0xC4A7E7),
        new Theme("gruvbox", 0x282828, 0xEBDBB2, 0xFABD2F)
    };

    /** Presets offered by the configuration screen, in display order (then "app" and "cover_accent"). */
    public static String[] presetIds() {
        String[] ids = new String[TABLE.length];
        for (int i = 0; i < TABLE.length; i++) ids[i] = TABLE[i].id;
        return ids;
    }

    private WidgetThemes() {}

    /** Unknown ids (and the cover-driven "adaptive" app theme without a cover) fall back to Midnight Glass. */
    public static Theme byId(@Nullable String id) {
        for (Theme t : TABLE) if (t.id.equals(id)) return t;
        return TABLE[0];
    }

    public static boolean isKnown(@Nullable String id) {
        if (APP.equals(id) || COVER_ACCENT.equals(id)) return true;
        for (Theme t : TABLE) if (t.id.equals(id)) return true;
        return false;
    }
}
