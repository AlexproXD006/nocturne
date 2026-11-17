package es.alexcloudweb.nocturne.updates;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Mirrors tests/lib/version.test.ts + tests/store/updateNotifications.test.ts (version cases). */
public class VersionCompareTest {
    private static int sign(int n) {
        return Integer.signum(n);
    }

    @Test
    public void orderedChain() {
        String[] order = {
            "1.0.3", "1.0.4-alpha", "1.0.4-alpha.1", "1.0.4-alpha.beta", "1.0.4-beta", "1.0.4-beta.2",
            "1.0.4-beta.11", "1.0.4-rc.1", "1.0.4", "1.0.5-beta.1", "1.1.0", "2.0.0"
        };
        for (int i = 0; i < order.length; i++) {
            for (int j = 0; j < order.length; j++) {
                assertEquals(order[i] + " vs " + order[j], sign(Integer.compare(i, j)), sign(VersionCompare.compare(order[i], order[j])));
            }
        }
    }

    @Test
    public void equalities() {
        assertEquals(0, VersionCompare.compare("1.0", "1.0.0"));
        assertEquals(0, VersionCompare.compare("v1.2.3", "1.2.3"));
        assertEquals(0, VersionCompare.compare("1.2.3+build.5", "1.2.3"));
        assertEquals(0, VersionCompare.compare(" 1.2.3 ", "1.2.3"));
    }

    @Test
    public void isNewer() {
        assertTrue(VersionCompare.isNewer("1.0.6", "1.0.5"));
        assertTrue(VersionCompare.isNewer("1.0.10", "1.0.9"));
        assertTrue(VersionCompare.isNewer("1.0.5", "1.0.5-beta.3"));
        assertFalse(VersionCompare.isNewer("1.0.5-beta.3", "1.0.5"));
        assertFalse(VersionCompare.isNewer("1.0.5", "1.0.5"));
        assertFalse(VersionCompare.isNewer("garbage", "1.0.5"));
        assertFalse(VersionCompare.isNewer(null, "1.0.5"));
        assertTrue(VersionCompare.isNewer("1.0.5", null));
    }
}
