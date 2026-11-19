package es.alexcloudweb.nocturne.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class WidgetColorsTest {
    private static final int[] SWATCHES = {
        0xFFFFFF00, 0xFFFFFFFF, 0xFF000000, 0xFF808080, 0xFF777777, 0xFFFF0000, 0xFF00FF00, 0xFF0000FF, 0xFFFFC0CB, 0xFF1D2B4A, 0xFF7F7F00, 0xFFFFA500
    };

    @Test
    public void contrastOfBlackOnWhiteIs21() {
        assertEquals(21.0, WidgetColors.contrast(WidgetColors.WHITE, WidgetColors.BLACK), 0.001);
        assertEquals(1.0, WidgetColors.contrast(0xFF123456, 0xFF123456), 0.001);
    }

    @Test
    public void onColorPicksTheReadableOne() {
        assertEquals(WidgetColors.WHITE, WidgetColors.onColorFor(0xFF0D1424));
        assertEquals(WidgetColors.BLACK, WidgetColors.onColorFor(0xFFFFFF00));
    }

    @Test
    public void ensureContrastReachesTheTargetForAnyPair() {
        for (int bg : SWATCHES) {
            for (int fg : SWATCHES) {
                int fixed = WidgetColors.ensureContrast(fg, WidgetColors.ensureBackground(bg, 4.5), 4.5);
                assertTrue(WidgetColors.contrast(fixed, WidgetColors.ensureBackground(bg, 4.5)) >= 4.5);
            }
        }
    }

    @Test
    public void ensureContrastLeavesGoodColoursAlone() {
        assertEquals(0xFFEEF2FA, WidgetColors.ensureContrast(0xFFEEF2FA, 0xFF0D1424, 4.5));
    }

    @Test
    public void paletteSchemeKeepsTextAndAccentReadable() {
        for (int dominant : SWATCHES) {
            for (int vibrant : new int[] {0, 0xFFFFFF00, 0xFF1D2B4A, 0xFFFF0000}) {
                WidgetColors.Scheme s = WidgetColors.fromPalette(dominant, vibrant, 0);
                assertTrue("text " + Integer.toHexString(dominant), WidgetColors.contrast(s.onBg, s.bg) >= 4.5);
                assertTrue("muted " + Integer.toHexString(dominant), WidgetColors.contrast(s.onBgMuted, s.bg) >= 4.5);
                assertTrue("accent " + Integer.toHexString(dominant), WidgetColors.contrast(s.accent, s.bg) >= 3.0);
            }
        }
    }

    @Test
    public void paletteBackgroundStaysDark() {
        WidgetColors.Scheme s = WidgetColors.fromPalette(0xFFFFFF00, 0xFFFFFF00, 0);
        assertTrue(WidgetColors.luminance(s.bg) < 0.25);
        assertEquals(WidgetColors.WHITE, s.onBg);
    }

    @Test
    public void paletteWithoutSwatchesStillWorks() {
        WidgetColors.Scheme s = WidgetColors.fromPalette(0, 0, 0);
        assertTrue(WidgetColors.contrast(s.onBg, s.bg) >= 4.5);
    }

    @Test
    public void lightCustomBackgroundGetsDarkText() {
        WidgetConfig cfg = new WidgetConfig(WidgetConfig.MODE_CUSTOM, "app", 0xFFFFFFFF, 0, 2);
        WidgetColors.Scheme s = WidgetColors.resolve(cfg, null, null, null);
        assertEquals(WidgetColors.BLACK, s.onBg);
        assertTrue(WidgetColors.contrast(s.onBg, s.bg) >= 4.5);
    }

    @Test
    public void midGreyCustomBackgroundIsNudgedUntilTextIsReadable() {
        WidgetConfig cfg = new WidgetConfig(WidgetConfig.MODE_CUSTOM, "app", 0xFF777777, 0, 2);
        WidgetColors.Scheme s = WidgetColors.resolve(cfg, null, null, null);
        assertTrue(WidgetColors.contrast(s.onBg, s.bg) >= 4.5);
        assertTrue(WidgetColors.contrast(s.onBgMuted, s.bg) >= 4.5);
    }

    @Test
    public void materialYouUsesSystemColoursWhenGivenAndFallsBackWhenNot() {
        WidgetConfig cfg = new WidgetConfig(WidgetConfig.MODE_MATERIAL, "app", 0, 0, 2);
        int[] system = {0xFF1B1B1F, 0xFFE3E2E6, 0xFFAEC6FF};
        WidgetColors.Scheme s = WidgetColors.resolve(cfg, null, null, system);
        assertEquals(0xFF1B1B1F, s.bg);
        assertEquals(0xFFAEC6FF, s.accent);
        WidgetColors.Scheme fallback = WidgetColors.resolve(cfg, null, null, null);
        assertEquals(WidgetThemes.byId("glass").scheme(null).bg, fallback.bg);
    }

    @Test
    public void adaptiveFollowsTheCover() {
        WidgetConfig cfg = new WidgetConfig(WidgetConfig.MODE_ADAPTIVE, "app", 0, 0, 2);
        WidgetColors.Scheme a = WidgetColors.resolve(cfg, null, new int[] {0xFFAA2222, 0xFFFF5555, 0}, null);
        WidgetColors.Scheme b = WidgetColors.resolve(cfg, null, new int[] {0xFF2222AA, 0xFF5555FF, 0}, null);
        assertTrue(a.bg != b.bg);
        // no cover yet: Midnight Glass
        assertEquals(WidgetThemes.byId("glass").scheme(null).bg, WidgetColors.resolve(cfg, null, null, null).bg);
    }

    @Test
    public void likeTheAppUsesTheAppsThemeAndAccent() {
        WidgetConfig cfg = new WidgetConfig(WidgetConfig.MODE_THEME, WidgetThemes.APP, 0, 0, 2);
        WidgetColors.Scheme s = WidgetColors.resolve(cfg, new AppThemeStore.State("nord", "#88c0d0"), null, null);
        assertEquals(WidgetThemes.byId("nord").scheme(null).bg, s.bg);
        assertEquals(WidgetColors.ensureContrast(0xFF88C0D0, s.bg, 3.0), s.accent);
    }

    @Test
    public void likeTheAppWithCoverAccentTakesTheVibrantSwatch() {
        WidgetConfig cfg = new WidgetConfig(WidgetConfig.MODE_THEME, WidgetThemes.APP, 0, 0, 2);
        int[] cover = {0xFF332211, 0xFFFF8800, 0};
        WidgetColors.Scheme s = WidgetColors.resolve(cfg, new AppThemeStore.State("dark", ""), cover, null);
        assertEquals(WidgetColors.ensureContrast(0xFFFF8800, s.bg, 3.0), s.accent);
    }

    @Test
    public void likeTheAdaptiveAppThemeUsesTheCoverPalette() {
        WidgetConfig cfg = new WidgetConfig(WidgetConfig.MODE_THEME, WidgetThemes.APP, 0, 0, 2);
        int[] cover = {0xFFAA2222, 0xFFFF5555, 0};
        WidgetColors.Scheme s = WidgetColors.resolve(cfg, new AppThemeStore.State("adaptive", ""), cover, null);
        assertEquals(WidgetColors.fromPalette(cover[0], cover[1], cover[2]).bg, s.bg);
    }

    @Test
    public void everyPresetIsReadable() {
        for (String id : WidgetThemes.presetIds()) {
            WidgetColors.Scheme s = WidgetThemes.byId(id).scheme(null);
            assertTrue(id, WidgetColors.contrast(s.onBg, s.bg) >= 4.5);
            assertTrue(id, WidgetColors.contrast(s.onBgMuted, s.bg) >= 4.5);
            assertTrue(id, WidgetColors.contrast(s.accent, s.bg) >= 3.0);
        }
    }

    @Test
    public void coverAccentKeepsMidnightGlass() {
        WidgetConfig cfg = new WidgetConfig(WidgetConfig.MODE_THEME, WidgetThemes.COVER_ACCENT, 0, 0, 2);
        WidgetColors.Scheme s = WidgetColors.resolve(cfg, null, new int[] {0, 0xFFFF5555, 0}, null);
        assertEquals(WidgetThemes.byId("glass").scheme(null).bg, s.bg);
    }

    @Test
    public void hexParsing() {
        assertEquals(Integer.valueOf(0xFF1D2B4A), WidgetColors.parseHex("#1d2b4a"));
        assertEquals(Integer.valueOf(0xFF1D2B4A), WidgetColors.parseHex("1D2B4A"));
        assertEquals(Integer.valueOf(0xFFAABBCC), WidgetColors.parseHex("#abc"));
        assertNull(WidgetColors.parseHex("#12345"));
        assertNull(WidgetColors.parseHex("zzzzzz"));
        assertNull(WidgetColors.parseHex(""));
        assertNull(WidgetColors.parseHex(null));
        assertEquals("#1d2b4a", WidgetColors.toHex(0xFF1D2B4A));
        assertNotNull(WidgetColors.parseHex(WidgetColors.toHex(0xFF010203)));
    }
}
