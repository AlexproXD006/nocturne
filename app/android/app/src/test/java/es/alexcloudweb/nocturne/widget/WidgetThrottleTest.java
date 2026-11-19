package es.alexcloudweb.nocturne.widget;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class WidgetThrottleTest {
    @Test
    public void idleWhenPausedOrWithoutALargeWidget() {
        WidgetThrottle t = new WidgetThrottle();
        assertFalse(t.shouldPush(10_000, false, true, 5_000, 1));
        assertFalse(t.shouldPush(10_000, true, false, 5_000, 1));
        assertTrue(t.shouldPush(10_000, true, true, 5_000, 1));
    }

    @Test
    public void neverMoreOftenThanTheMinimumInterval() {
        WidgetThrottle t = new WidgetThrottle();
        assertTrue(t.shouldPush(10_000, true, true, 1_000, 0));
        assertFalse(t.shouldPush(10_300, true, true, 2_000, 1));
        assertFalse(t.shouldPush(10_899, true, true, 2_000, 1));
        assertTrue(t.shouldPush(10_900, true, true, 2_000, 1));
    }

    @Test
    public void skipsWhenNothingVisibleChanged() {
        WidgetThrottle t = new WidgetThrottle();
        assertTrue(t.shouldPush(10_000, true, true, 5_100, 3));
        // same second, same lyric line
        assertFalse(t.shouldPush(11_000, true, true, 5_900, 3));
        // next whole second
        assertTrue(t.shouldPush(12_000, true, true, 6_050, 3));
        // same second but a new lyric line
        assertTrue(t.shouldPush(13_000, true, true, 6_900, 4));
    }

    @Test
    public void aboutOncePerSecondOverAMinute() {
        WidgetThrottle t = new WidgetThrottle();
        int pushes = 0;
        for (long now = 0; now < 60_000; now += 250) if (t.shouldPush(now, true, true, now, 0)) pushes++;
        assertTrue("pushes " + pushes, pushes >= 55 && pushes <= 66);
    }

    @Test
    public void resetLetsTheNextTickThrough() {
        WidgetThrottle t = new WidgetThrottle();
        assertTrue(t.shouldPush(10_000, true, true, 5_000, 1));
        assertFalse(t.shouldPush(10_100, true, true, 5_000, 1));
        t.reset();
        assertTrue(t.shouldPush(10_100, true, true, 5_000, 1));
    }

    @Test
    public void seekingBackwardsPushes() {
        WidgetThrottle t = new WidgetThrottle();
        assertTrue(t.shouldPush(10_000, true, true, 90_000, 5));
        assertTrue(t.shouldPush(11_000, true, true, 10_000, 1));
    }
}
