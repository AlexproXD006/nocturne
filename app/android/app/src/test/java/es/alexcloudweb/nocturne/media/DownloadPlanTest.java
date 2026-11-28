package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.scheduler.Requirements;
import org.json.JSONObject;
import org.junit.Test;

public class DownloadPlanTest {
    @Test
    public void mapsMedia3StatesToTheNamesTheWebViewShows() {
        assertEquals("done", DownloadPlan.stateName(Download.STATE_COMPLETED, 0));
        assertEquals("failed", DownloadPlan.stateName(Download.STATE_FAILED, 0));
        assertEquals("removing", DownloadPlan.stateName(Download.STATE_REMOVING, 0));
        assertEquals("downloading", DownloadPlan.stateName(Download.STATE_DOWNLOADING, 0));
        assertEquals("queued", DownloadPlan.stateName(Download.STATE_QUEUED, 0));
        assertEquals("queued", DownloadPlan.stateName(Download.STATE_RESTARTING, 0));
    }

    @Test
    public void aStoppedDownloadIsPausedOnlyForTheUserStopReason() {
        assertEquals("paused", DownloadPlan.stateName(Download.STATE_STOPPED, DownloadPlan.STOP_USER_PAUSED));
        assertEquals("queued", DownloadPlan.stateName(Download.STATE_STOPPED, 0));
    }

    @Test
    public void wifiOnlyRequiresAnUnmeteredNetwork() {
        assertEquals(Requirements.NETWORK_UNMETERED, DownloadPlan.requirements(true));
        assertEquals(Requirements.NETWORK, DownloadPlan.requirements(false));
    }

    @Test
    public void percentIsClampedAndUnknownIsMinusOne() {
        assertEquals(-1, DownloadPlan.percent(-1f, false));
        assertEquals(-1, DownloadPlan.percent(Float.NaN, false));
        assertEquals(42, DownloadPlan.percent(41.6f, false));
        assertEquals(100, DownloadPlan.percent(130f, false));
        assertEquals(100, DownloadPlan.percent(-1f, true));
    }

    @Test
    public void storageLimitCheck() {
        assertFalse(DownloadPlan.overLimit(10, 10, 0)); // no limit
        assertFalse(DownloadPlan.overLimit(10, 10, 20));
        assertTrue(DownloadPlan.overLimit(10, 11, 20));
        assertTrue(DownloadPlan.overLimit(25, 0, 20));
    }

    @Test
    public void requestUriCarriesTheTrackIdAndIsEncoded() {
        assertEquals("nocturne://track/abc123", DownloadPlan.uriOf("abc123"));
        assertEquals("nocturne://track/a%20b%2Fc", DownloadPlan.uriOf("a b/c"));
    }

    @Test
    public void itemJsonHasTheFieldsTheUiReads() throws Exception {
        JSONObject o = DownloadPlan.item("t1", Download.STATE_DOWNLOADING, 0, 55.4f, 1000, 2000);
        assertEquals("t1", o.getString("id"));
        assertEquals("downloading", o.getString("state"));
        assertEquals(55, o.getInt("percent"));
        assertEquals(1000, o.getLong("bytes"));
        assertEquals(2000, o.getLong("total"));
        JSONObject done = DownloadPlan.item("t2", Download.STATE_COMPLETED, 0, -1f, 5, -1);
        assertEquals(100, done.getInt("percent"));
        assertEquals(0, done.getLong("total"));
    }

    @Test
    public void metaDirectoryNamesAreFileSystemSafe() {
        assertEquals("abc-1_2", OfflineMeta.safe("abc-1_2"));
        assertEquals("a~2fb~2e~2e", OfflineMeta.safe("a/b.."));
        assertEquals("_", OfflineMeta.safe(""));
    }
}
