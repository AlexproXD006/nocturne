package es.alexcloudweb.nocturne.media;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class SessionStoreTest {
    private static JSONObject item(String uid, String trackId) throws Exception {
        return new JSONObject().put("uid", uid).put("trackId", trackId).put("title", "T" + trackId).put("artist", "A").put("album", "B").put("artworkUrl", "http://x/a.jpg").put("duration", 12.5);
    }

    private static JSONObject snap(int n, int index) throws Exception {
        JSONArray items = new JSONArray();
        for (int i = 0; i < n; i++) items.put(item("u" + i, "t" + i));
        return new JSONObject().put("items", items).put("index", index).put("position", 42.25).put("playing", true).put("repeat", "all").put("shuffle", true).put("contextName", "Mix");
    }

    @Test
    public void roundTripsQueueIndexPositionRepeatAndShuffle() throws Exception {
        SessionStore.Restored r = SessionStore.parse(snap(3, 2).toString());
        assertNotNull(r);
        assertEquals(3, r.entries.size());
        assertEquals(2, r.index);
        assertEquals(42250, r.positionMs);
        assertEquals("all", r.repeat);
        assertTrue(r.shuffle);
        assertEquals("Mix", r.contextName);
        assertEquals("u1", r.entries.get(1).uid);
        assertEquals("t1", r.entries.get(1).trackId);
        assertEquals(12500, r.entries.get(1).durationMs);
    }

    @Test
    public void keepsFullTrackJsonWhenPresent() throws Exception {
        JSONObject s = snap(1, 0);
        s.getJSONArray("items").getJSONObject(0).put("track", new JSONObject().put("id", "t0"));
        SessionStore.Restored r = SessionStore.parse(s.toString());
        assertNotNull(r);
        assertTrue(r.entries.get(0).trackJson.contains("t0"));
    }

    @Test
    public void garbageAndEmptyGiveNull() {
        assertNull(SessionStore.parse(null));
        assertNull(SessionStore.parse(""));
        assertNull(SessionStore.parse("not json"));
        assertNull(SessionStore.parse("{\"items\":[]}"));
        assertNull(SessionStore.parse("{\"items\":[{\"uid\":\"\"}]}"));
    }

    @Test
    public void skipsBrokenEntriesAndRemapsIndex() throws Exception {
        JSONObject s = snap(3, 2);
        s.getJSONArray("items").put(0, new JSONObject().put("uid", "x"));
        SessionStore.Restored r = SessionStore.parse(s.toString());
        assertNotNull(r);
        assertEquals(2, r.entries.size());
        assertEquals(1, r.index);
        assertEquals("u2", r.entries.get(r.index).uid);
    }

    @Test
    public void clampsOutOfRangeIndexAndUnknownRepeat() throws Exception {
        JSONObject s = snap(2, 9).put("repeat", "weird").put("shuffle", false);
        SessionStore.Restored r = SessionStore.parse(s.toString());
        assertNotNull(r);
        assertEquals(1, r.index);
        assertEquals("off", r.repeat);
        assertFalse(r.shuffle);
    }

    @Test
    public void trimKeepsCurrentItemWithinTheLimit() throws Exception {
        int n = SessionStore.MAX_ITEMS + 100;
        JSONObject t = SessionStore.trim(snap(n, n - 1));
        assertEquals(SessionStore.MAX_ITEMS, t.getJSONArray("items").length());
        assertEquals(SessionStore.MAX_ITEMS - 1, t.getInt("index"));
        assertEquals("u" + (n - 1), t.getJSONArray("items").getJSONObject(t.getInt("index")).getString("uid"));
        JSONObject head = SessionStore.trim(snap(n, 0));
        assertEquals(0, head.getInt("index"));
        assertEquals("u0", head.getJSONArray("items").getJSONObject(0).getString("uid"));
    }
}
