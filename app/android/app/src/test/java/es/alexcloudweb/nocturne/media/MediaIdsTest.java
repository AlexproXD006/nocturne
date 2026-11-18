package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class MediaIdsTest {
    @Test
    public void trackIdRoundTripsWithContainer() {
        String id = MediaIds.track("tr/odd id|1", MediaIds.container("playlist", "p 9"));
        MediaIds.Parsed p = MediaIds.parse(id);
        assertEquals("track", p.kind);
        assertEquals("tr/odd id|1", p.id);
        assertEquals("playlist:p+9", p.ctx);
        MediaIds.Parsed c = MediaIds.parse(p.ctx);
        assertEquals("playlist", c.kind);
        assertEquals("p 9", c.id);
    }

    @Test
    public void tabsAndRootParseAsBareKinds() {
        assertEquals("liked", MediaIds.parse(MediaIds.LIKED).kind);
        assertEquals("", MediaIds.parse(MediaIds.ROOT).id);
        assertEquals("", MediaIds.parse(null).kind);
    }

    @Test
    public void windowIsCappedAtOneHundredItems() {
        assertEquals(100, MediaIds.window(0, 500)[1]);
        assertEquals(200, MediaIds.window(2, 100)[0]);
        assertEquals(100, MediaIds.window(0, 0)[1]);
        assertEquals(0, MediaIds.window(-3, 10)[0]);
    }

    @Test
    public void sliceStaysInsideTheList() {
        int[] s = MediaIds.slice(130, MediaIds.window(1, 100));
        assertEquals(100, s[0]);
        assertEquals(130, s[1]);
        int[] none = MediaIds.slice(5, MediaIds.window(3, 100));
        assertEquals(5, none[0]);
        assertEquals(5, none[1]);
    }
}
