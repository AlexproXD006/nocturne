package es.alexcloudweb.nocturne.media;

import android.content.Context;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The playback session kept across app close, process death and reboot: queue (as the service's
 * snapshot JSON), current index and position, repeat and shuffle. {@link #parse} is pure so it is unit
 * tested; the SharedPreferences part is a thin wrapper.
 */
final class SessionStore {
    private static final String PREFS = "nocturne_native_prefs";
    private static final String KEY = "playbackSession";
    /** Entries kept (history before the current item is cut first). */
    static final int MAX_ITEMS = 500;

    private SessionStore() {}

    /** One queue entry. */
    static final class Entry {
        final String uid;
        final String trackId;
        final String title;
        final String artist;
        final String album;
        final String artworkUrl;
        final long durationMs;
        @Nullable final String trackJson;

        Entry(String uid, String trackId, String title, String artist, String album, String artworkUrl, long durationMs, @Nullable String trackJson) {
            this.uid = uid;
            this.trackId = trackId;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.artworkUrl = artworkUrl;
            this.durationMs = durationMs;
            this.trackJson = trackJson;
        }
    }

    static final class Restored {
        final List<Entry> entries;
        final int index;
        final long positionMs;
        final String repeat;
        final boolean shuffle;
        final String contextName;

        Restored(List<Entry> entries, int index, long positionMs, String repeat, boolean shuffle, String contextName) {
            this.entries = entries;
            this.index = index;
            this.positionMs = positionMs;
            this.repeat = repeat;
            this.shuffle = shuffle;
            this.contextName = contextName;
        }
    }

    /** Trims a snapshot to {@link #MAX_ITEMS} entries around the current one; returns it unchanged when small. */
    static JSONObject trim(JSONObject snap) throws JSONException {
        JSONArray items = snap.optJSONArray("items");
        if (items == null || items.length() <= MAX_ITEMS) return snap;
        int index = snap.optInt("index", 0);
        int cut = Math.min(Math.max(0, index), items.length() - MAX_ITEMS);
        JSONArray out = new JSONArray();
        for (int i = cut; i < cut + MAX_ITEMS; i++) out.put(items.get(i));
        JSONObject copy = new JSONObject(snap.toString());
        copy.put("items", out);
        copy.put("index", index - cut);
        return copy;
    }

    /** Parses a stored session; anything malformed or empty gives null (never throws). */
    @Nullable
    static Restored parse(@Nullable String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            JSONObject o = new JSONObject(json);
            JSONArray arr = o.optJSONArray("items");
            if (arr == null) return null;
            List<Entry> entries = new ArrayList<>();
            int index = o.optInt("index", 0);
            int newIndex = -1;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject it = arr.optJSONObject(i);
                if (it == null) continue;
                String uid = it.optString("uid", "");
                String trackId = it.optString("trackId", "");
                if (uid.isEmpty() || trackId.isEmpty()) continue;
                if (i == index) newIndex = entries.size();
                JSONObject track = it.optJSONObject("track");
                entries.add(new Entry(
                    uid,
                    trackId,
                    it.optString("title", ""),
                    it.optString("artist", ""),
                    it.optString("album", ""),
                    it.optString("artworkUrl", ""),
                    Math.round(it.optDouble("duration", 0) * 1000),
                    track == null ? null : track.toString()));
            }
            if (entries.isEmpty()) return null;
            if (newIndex < 0) newIndex = Math.min(Math.max(0, index), entries.size() - 1);
            String repeat = o.optString("repeat", "off");
            if (!"all".equals(repeat) && !"one".equals(repeat)) repeat = "off";
            return new Restored(
                entries,
                newIndex,
                Math.max(0, Math.round(o.optDouble("position", 0) * 1000)),
                repeat,
                o.optBoolean("shuffle", false),
                o.optString("contextName", ""));
        } catch (JSONException e) {
            return null;
        }
    }

    static void save(Context ctx, JSONObject snapshot) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, trim(snapshot).toString()).apply();
        } catch (JSONException | RuntimeException ignored) {
            /* best effort */
        }
    }

    @Nullable
    static String load(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
    }

    static void clear(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply();
    }
}
