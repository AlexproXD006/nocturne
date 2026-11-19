package es.alexcloudweb.nocturne.widget;

import androidx.annotation.Nullable;

/**
 * Colour derivation for the widgets, on plain ARGB ints (no android.graphics) so it is unit tested.
 * Text colours are always pushed to a WCAG contrast of at least {@link #TEXT_CONTRAST} against the
 * (opaque) background colour; the accent, used for progress and the like heart, to {@link #UI_CONTRAST}.
 */
public final class WidgetColors {
    public static final double TEXT_CONTRAST = 4.5;
    public static final double UI_CONTRAST = 3.0;
    public static final int WHITE = 0xFFFFFFFF;
    public static final int BLACK = 0xFF000000;
    /** Midnight Glass ice blue. */
    public static final int ICE_BLUE = 0xFF8FB4FF;

    private WidgetColors() {}

    /** Resolved colours of one widget (all opaque). */
    public static final class Scheme {
        public final int bg;
        public final int onBg;
        public final int onBgMuted;
        public final int accent;

        Scheme(int bg, int onBg, int onBgMuted, int accent) {
            this.bg = bg;
            this.onBg = onBg;
            this.onBgMuted = onBgMuted;
            this.accent = accent;
        }
    }

    private static double channel(int c) {
        double s = c / 255.0;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }

    public static double luminance(int argb) {
        return 0.2126 * channel((argb >> 16) & 0xFF) + 0.7152 * channel((argb >> 8) & 0xFF) + 0.0722 * channel(argb & 0xFF);
    }

    public static double contrast(int a, int b) {
        double la = luminance(a);
        double lb = luminance(b);
        double hi = Math.max(la, lb);
        double lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    }

    /** Opaque mix: {@code t} of {@code fg} over {@code bg}. */
    public static int mix(int fg, int bg, double t) {
        t = Math.min(1, Math.max(0, t));
        int r = (int) Math.round(((fg >> 16) & 0xFF) * t + ((bg >> 16) & 0xFF) * (1 - t));
        int g = (int) Math.round(((fg >> 8) & 0xFF) * t + ((bg >> 8) & 0xFF) * (1 - t));
        int b = (int) Math.round((fg & 0xFF) * t + (bg & 0xFF) * (1 - t));
        return 0xFF000000 | (r << 16) | (g << 8) | b;
    }

    public static int opaque(int argb) {
        return 0xFF000000 | (argb & 0xFFFFFF);
    }

    /** {@code rgb} with the given alpha (0..255). */
    public static int withAlpha(int rgb, int alpha) {
        return (Math.min(255, Math.max(0, alpha)) << 24) | (rgb & 0xFFFFFF);
    }

    /** White or black, whichever reads better on {@code bg}. */
    public static int onColorFor(int bg) {
        return contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK;
    }

    /** Moves {@code fg} towards white or black (whichever helps) until it reaches {@code min} contrast on {@code bg}. */
    public static int ensureContrast(int fg, int bg, double min) {
        fg = opaque(fg);
        bg = opaque(bg);
        if (contrast(fg, bg) >= min) return fg;
        int target = onColorFor(bg);
        for (int i = 1; i <= 20; i++) {
            int c = mix(target, fg, i / 20.0);
            if (contrast(c, bg) >= min) return c;
        }
        return target;
    }

    /** Darkens or lightens {@code bg} (away from mid grey) until white or black text can reach {@code min}. */
    static int ensureBackground(int bg, double min) {
        bg = opaque(bg);
        if (Math.max(contrast(WHITE, bg), contrast(BLACK, bg)) >= min) return bg;
        int target = luminance(bg) > 0.18 ? WHITE : BLACK;
        for (int i = 1; i <= 20; i++) {
            int c = mix(target, bg, i / 20.0);
            if (Math.max(contrast(WHITE, c), contrast(BLACK, c)) >= min) return c;
        }
        return target;
    }

    /** Applies the contrast rules to a wished-for background / text / accent. */
    public static Scheme fromBase(int bg, int preferredOn, int accent) {
        int b = ensureBackground(bg, TEXT_CONTRAST);
        int on = ensureContrast(preferredOn, b, TEXT_CONTRAST);
        int muted = ensureContrast(mix(on, b, 0.72), b, TEXT_CONTRAST);
        int acc = ensureContrast(accent, b, UI_CONTRAST);
        return new Scheme(b, on, muted, acc);
    }

    /**
     * Adaptive colours from the cover: a dark version of the dominant colour as background, light text,
     * the vibrant swatch as accent. A swatch of 0 means "not available".
     */
    public static Scheme fromPalette(int dominant, int vibrant, int muted) {
        int base = dominant != 0 ? dominant : muted != 0 ? muted : vibrant != 0 ? vibrant : 0xFF1D2B4A;
        int bg = mix(BLACK, opaque(base), 0.55);
        int accent = vibrant != 0 ? vibrant : mix(WHITE, opaque(base), 0.45);
        return fromBase(bg, WHITE, accent);
    }

    /** Parses "#RGB", "#RRGGBB" (with or without #) to an opaque ARGB int; null when invalid. */
    @Nullable
    public static Integer parseHex(@Nullable String s) {
        if (s == null) return null;
        String h = s.trim();
        if (h.startsWith("#")) h = h.substring(1);
        if (h.length() == 3) {
            StringBuilder sb = new StringBuilder();
            for (char ch : h.toCharArray()) sb.append(ch).append(ch);
            h = sb.toString();
        }
        if (h.length() != 6) return null;
        try {
            return 0xFF000000 | Integer.parseInt(h, 16);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public static String toHex(int argb) {
        return String.format(java.util.Locale.ROOT, "#%06x", argb & 0xFFFFFF);
    }

    /**
     * The scheme for a widget configuration.
     *
     * @param cover  {dominant, vibrant, muted} of the current cover, or null when there is none yet
     * @param system {background, text, accent} from the Android 12+ dynamic colours, or null
     */
    public static Scheme resolve(WidgetConfig cfg, @Nullable AppThemeStore.State app, @Nullable int[] cover, @Nullable int[] system) {
        WidgetThemes.Theme glass = WidgetThemes.byId(WidgetThemes.GLASS);
        switch (cfg.mode) {
            case WidgetConfig.MODE_ADAPTIVE:
                return cover != null ? fromPalette(cover[0], cover[1], cover[2]) : glass.scheme(null);
            case WidgetConfig.MODE_MATERIAL:
                return system != null ? fromBase(system[0], system[1], system[2]) : glass.scheme(null);
            case WidgetConfig.MODE_CUSTOM: {
                int bg = cfg.customColor;
                int accent = cover != null && cover[1] != 0 ? cover[1] : ICE_BLUE;
                return fromBase(bg, onColorFor(bg), accent);
            }
            default:
                break;
        }
        String id = cfg.themeId;
        if (WidgetThemes.APP.equals(id)) {
            String appTheme = app == null ? WidgetThemes.GLASS : app.theme;
            if (WidgetThemes.ADAPTIVE.equals(appTheme) && cover != null) return fromPalette(cover[0], cover[1], cover[2]);
            WidgetThemes.Theme t = WidgetThemes.byId(appTheme);
            Integer accent = app == null ? null : parseHex(app.accent);
            if (accent == null && cover != null && cover[1] != 0) accent = cover[1];
            return t.scheme(accent);
        }
        if (WidgetThemes.COVER_ACCENT.equals(id)) {
            Integer accent = cover != null && cover[1] != 0 ? Integer.valueOf(cover[1]) : null;
            return glass.scheme(accent);
        }
        return WidgetThemes.byId(id).scheme(null);
    }
}
