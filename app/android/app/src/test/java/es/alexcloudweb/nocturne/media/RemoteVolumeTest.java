package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RemoteVolumeTest {
    @Test
    public void mapsConnectVolumeToSteps() {
        assertEquals(0, RemoteVolume.toStep(0));
        assertEquals(20, RemoteVolume.toStep(1));
        assertEquals(10, RemoteVolume.toStep(0.5));
        assertEquals(3, RemoteVolume.toStep(0.14));
        assertEquals(0, RemoteVolume.toStep(-3));
        assertEquals(20, RemoteVolume.toStep(7));
        assertEquals(0, RemoteVolume.toStep(Double.NaN));
    }

    @Test
    public void mapsStepsBackToConnectVolume() {
        assertEquals(0.0, RemoteVolume.fromStep(0), 1e-9);
        assertEquals(1.0, RemoteVolume.fromStep(20), 1e-9);
        assertEquals(0.25, RemoteVolume.fromStep(5), 1e-9);
        assertEquals(1.0, RemoteVolume.fromStep(99), 1e-9);
        assertEquals(0.0, RemoteVolume.fromStep(-4), 1e-9);
        for (int i = 0; i <= RemoteVolume.MAX_STEPS; i++) assertEquals(i, RemoteVolume.toStep(RemoteVolume.fromStep(i)));
    }

    @Test
    public void remoteStateIsAdoptedAndReportsChange() {
        RemoteVolume v = new RemoteVolume();
        assertTrue(v.fromRemote(0.5, false, 0));
        assertEquals(10, v.step());
        assertFalse(v.fromRemote(0.5, false, 10));
        assertTrue(v.fromRemote(0.5, true, 20));
        assertTrue(v.muted());
    }

    @Test
    public void keyPressesClampAndHoldAgainstStaleState() {
        RemoteVolume v = new RemoteVolume();
        v.fromRemote(0.5, false, 0);
        assertTrue(v.userSet(11, 100));
        // A stale push (still 10 steps) right after the key press must not undo it.
        assertFalse(v.fromRemote(0.5, false, 200));
        assertEquals(11, v.step());
        // After the hold the PC state wins again (someone changed the PC volume).
        assertTrue(v.fromRemote(0.9, false, 100 + RemoteVolume.HOLD_MS));
        assertEquals(18, v.step());
        assertFalse(v.userSet(25, 5000) && v.step() != 20);
        assertEquals(20, v.step());
        assertFalse(v.userSet(20, 5001));
        v.userSet(-5, 6000);
        assertEquals(0, v.step());
    }

    @Test
    public void muteToggles() {
        RemoteVolume v = new RemoteVolume();
        assertTrue(v.userMute(true, 0));
        assertFalse(v.userMute(true, 1));
        assertTrue(v.muted());
        assertTrue(v.userMute(false, 2));
    }
}
