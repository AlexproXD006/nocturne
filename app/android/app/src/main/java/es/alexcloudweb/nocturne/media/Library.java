package es.alexcloudweb.nocturne.media;

import androidx.annotation.Nullable;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The Android Auto browse tree, read from the server API: mixes, playlists, liked songs, recently
 * played, albums, artists. Blocking calls: run off the main thread. Lists the server pages
 * (liked, playlists, albums, artists) are fetched per page (at most 100 per node); the rest are
 * fetched whole and sliced.
 */
final class Library {
    /** One row of a browse list. */
    static final class Node {
        final String id;
        final String title;
        final String subtitle;
        final String artUrl;
        final boolean browsable;
        final boolean playable;
        @Nullable final TrackInfo track;

        Node(String id, String title, String subtitle, String artUrl, boolean browsable, boolean playable, @Nullable TrackInfo track) {
            this.id = id;
            this.title = title;
            this.subtitle = subtitle;
            this.artUrl = artUrl;
            this.browsable = browsable;
            this.playable = playable;
            this.track = track;
        }
    }

    /** The songs behind a container: the queue when it is played. */
    static final class TrackList {
        final String name;
        final List<TrackInfo> tracks;

        TrackList(String name, List<TrackInfo> tracks) {
            this.name = name;
            this.tracks = tracks;
        }
    }

    /** Songs queued from one container (liked songs can be huge). */
    static final int MAX_QUEUE = 300;
    private static final long CACHE_MS = 45_000;

    private static final class Cached {
        final long at;
        final TrackList list;

        Cached(long at, TrackList list) {
            this.at = at;
            this.list = list;
        }
    }

    private final NocturneApi api;
    private final Map<String, Cached> cache = new HashMap<>();

    Library(NocturneApi api) {
        this.api = api;
    }

    synchronized void clearCache() {
        cache.clear();
    }

    /** Children of {@code parentId} for one Media3 page. */
    List<Node> children(String parentId, int page, int pageSize) throws IOException {
        int[] w = MediaIds.window(page, pageSize);
        MediaIds.Parsed p = MediaIds.parse(parentId);
        switch (p.kind) {
            case MediaIds.MIXES: {
                JSONArray items = api.getJson("/v1/mixes").optJSONArray("items");
                return slice(collections(items, MediaIds.KIND_MIX), w);
            }
            case MediaIds.PLAYLISTS:
                return collections(pageItems("/v1/library/playlists", w), MediaIds.KIND_PLAYLIST);
            case MediaIds.ALBUMS:
                return albums(pageItems("/v1/library/albums", w));
            case MediaIds.ARTISTS:
                return artists(pageItems("/v1/library/artists", w));
            case MediaIds.LIKED:
                return tracks(pageItems("/v1/library/tracks", w), MediaIds.LIKED);
            case MediaIds.RECENT:
                return slice(tracks(recentItems(), MediaIds.RECENT), w);
            case MediaIds.KIND_ALBUM: {
                TrackList t = tracksOf(parentId);
                return slice(tracks(t.tracks, parentId), w);
            }
            case MediaIds.KIND_ARTIST: {
                List<Node> out = new ArrayList<>();
                if (w[0] == 0) {
                    JSONObject a = api.getJson("/v1/artists/" + NocturneApi.pathId(p.id));
                    out.addAll(albums(a.optJSONArray("albums")));
                }
                TrackList t = tracksOf(parentId);
                out.addAll(tracks(t.tracks, parentId));
                return slice(out, w);
            }
            case MediaIds.KIND_MIX:
            case MediaIds.KIND_PLAYLIST: {
                TrackList t = tracksOf(parentId);
                return slice(tracks(t.tracks, parentId), w);
            }
            default:
                return new ArrayList<>();
        }
    }

    /** Every song of a container, for the queue. {@code ctx}: liked, recent, mix:ID, playlist:ID, album:ID, artist:ID, search:Q. */
    synchronized TrackList tracksOf(String ctx) throws IOException {
        Cached c = cache.get(ctx);
        long now = System.currentTimeMillis();
        if (c != null && now - c.at < CACHE_MS) return c.list;
        TrackList list = loadTracks(ctx);
        if (cache.size() > 16) cache.clear();
        cache.put(ctx, new Cached(now, list));
        return list;
    }

    private TrackList loadTracks(String ctx) throws IOException {
        MediaIds.Parsed p = MediaIds.parse(ctx);
        switch (p.kind) {
            case MediaIds.LIKED: {
                List<TrackInfo> out = new ArrayList<>();
                for (int off = 0; off < MAX_QUEUE; off += 100) {
                    JSONObject page = api.getJson("/v1/library/tracks" + NocturneApi.query("offset", off, "limit", 100));
                    JSONArray items = page.optJSONArray("items");
                    out.addAll(trackInfos(items));
                    if (items == null || items.length() < 100 || out.size() >= page.optInt("total", Integer.MAX_VALUE)) break;
                }
                return new TrackList("", out);
            }
            case MediaIds.RECENT:
                return new TrackList("", trackInfos(recentItems()));
            case MediaIds.KIND_MIX: {
                JSONObject o = api.getJson("/v1/mixes/" + NocturneApi.pathId(p.id));
                return new TrackList(o.optString("name", ""), cap(trackInfos(o.optJSONArray("tracks"))));
            }
            case MediaIds.KIND_PLAYLIST: {
                JSONObject o = api.getJson("/v1/playlists/" + NocturneApi.pathId(p.id));
                return new TrackList(o.optString("name", ""), cap(trackInfos(o.optJSONArray("tracks"))));
            }
            case MediaIds.KIND_ALBUM: {
                JSONObject o = api.getJson("/v1/albums/" + NocturneApi.pathId(p.id));
                return new TrackList(o.optString("title", ""), cap(trackInfos(o.optJSONArray("tracks"))));
            }
            case MediaIds.KIND_ARTIST: {
                JSONObject o = api.getJson("/v1/artists/" + NocturneApi.pathId(p.id));
                return new TrackList(o.optString("name", ""), cap(trackInfos(o.optJSONArray("topTracks"))));
            }
            case MediaIds.KIND_SEARCH: {
                JSONObject o = api.getJson("/v1/search" + NocturneApi.query("q", p.id, "types", "track", "limit", 50));
                return new TrackList(p.id, trackInfos(o.optJSONArray("tracks")));
            }
            default:
                return new TrackList("", new ArrayList<>());
        }
    }

    /** A single song (queue item chosen without a container). */
    @Nullable
    TrackInfo track(String trackId) throws IOException {
        return TrackInfo.from(api.getJson("/v1/library/tracks/" + NocturneApi.pathId(trackId)));
    }

    /** Search results: tracks first, then albums, artists and playlists. */
    List<Node> search(String query, int limit) throws IOException {
        JSONObject o = api.getJson("/v1/search" + NocturneApi.query("q", query, "limit", Math.min(limit, 20)));
        List<Node> out = new ArrayList<>();
        out.addAll(tracks(trackInfos(o.optJSONArray("tracks")), MediaIds.container(MediaIds.KIND_SEARCH, query)));
        out.addAll(albums(o.optJSONArray("albums")));
        out.addAll(artists(o.optJSONArray("artists")));
        out.addAll(collections(o.optJSONArray("playlists"), MediaIds.KIND_PLAYLIST));
        return out;
    }

    /**
     * Voice search ("play X"): an artist, playlist or album named like the query wins and plays whole;
     * otherwise the matching songs. Returns the container id to play ({@code search:Q} as the fallback).
     */
    String resolveVoiceQuery(String query) throws IOException {
        JSONObject o = api.getJson("/v1/search" + NocturneApi.query("q", query, "limit", 10));
        String q = query.trim().toLowerCase(Locale.ROOT);
        String artist = exact(o.optJSONArray("artists"), "name", q);
        if (artist != null) return MediaIds.container(MediaIds.KIND_ARTIST, artist);
        String playlist = exact(o.optJSONArray("playlists"), "name", q);
        if (playlist != null) return MediaIds.container(MediaIds.KIND_PLAYLIST, playlist);
        String album = exact(o.optJSONArray("albums"), "title", q);
        if (album != null) return MediaIds.container(MediaIds.KIND_ALBUM, album);
        JSONArray tracks = o.optJSONArray("tracks");
        if (tracks == null || tracks.length() == 0) {
            JSONArray artists = o.optJSONArray("artists");
            JSONObject first = artists == null ? null : artists.optJSONObject(0);
            if (first != null) return MediaIds.container(MediaIds.KIND_ARTIST, first.optString("id", ""));
        }
        return MediaIds.container(MediaIds.KIND_SEARCH, query);
    }

    @Nullable
    private static String exact(@Nullable JSONArray arr, String field, String lowerQuery) {
        if (arr == null) return null;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o != null && o.optString(field, "").trim().toLowerCase(Locale.ROOT).equals(lowerQuery)) return o.optString("id", null);
        }
        return null;
    }

    // ---- JSON -> nodes ------------------------------------------------------------------------------

    @Nullable
    private JSONArray pageItems(String path, int[] w) throws IOException {
        return api.getJson(path + NocturneApi.query("offset", w[0], "limit", w[1])).optJSONArray("items");
    }

    @Nullable
    private JSONArray recentItems() throws IOException {
        JSONArray sections = api.getJson("/v1/home").optJSONArray("sections");
        if (sections == null) return null;
        JSONArray fallback = null;
        for (int i = 0; i < sections.length(); i++) {
            JSONObject s = sections.optJSONObject(i);
            if (s == null || !"tracks".equals(s.optString("kind"))) continue;
            if ("recent".equals(s.optString("id"))) return s.optJSONArray("items");
            if (fallback == null) fallback = s.optJSONArray("items");
        }
        return fallback;
    }

    private static List<TrackInfo> trackInfos(@Nullable JSONArray arr) {
        List<TrackInfo> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            TrackInfo t = TrackInfo.from(arr.optJSONObject(i));
            if (t != null) out.add(t);
        }
        return out;
    }

    private static List<TrackInfo> cap(List<TrackInfo> l) {
        return l.size() > MAX_QUEUE ? new ArrayList<>(l.subList(0, MAX_QUEUE)) : l;
    }

    private static <T> List<T> slice(List<T> all, int[] w) {
        int[] s = MediaIds.slice(all.size(), w);
        return new ArrayList<>(all.subList(s[0], s[1]));
    }

    private static List<Node> tracks(@Nullable JSONArray arr, String ctx) {
        return tracks(trackInfos(arr), ctx);
    }

    private static List<Node> tracks(List<TrackInfo> list, String ctx) {
        List<Node> out = new ArrayList<>();
        for (TrackInfo t : list) {
            out.add(new Node(MediaIds.track(t.id, ctx), t.title, t.artist, t.artUrl, false, true, t));
        }
        return out;
    }

    private static List<Node> collections(@Nullable JSONArray arr, String kind) {
        List<Node> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null || o.optString("id", "").isEmpty()) continue;
            // Mixes may also arrive flagged in a playlists list; their ids open the mix endpoint.
            String k = o.optBoolean("mix", false) ? MediaIds.KIND_MIX : kind;
            JSONObject owner = o.optJSONObject("owner");
            out.add(new Node(
                MediaIds.container(k, o.optString("id")),
                o.optString("name", ""),
                owner == null ? o.optString("description", "") : owner.optString("name", ""),
                TrackInfo.pickImage(o.optJSONArray("artwork"), 512), true, true, null));
        }
        return out;
    }

    private static List<Node> albums(@Nullable JSONArray arr) {
        List<Node> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null || o.optString("id", "").isEmpty()) continue;
            out.add(new Node(
                MediaIds.container(MediaIds.KIND_ALBUM, o.optString("id")),
                o.optString("title", ""),
                TrackInfo.names(o.optJSONArray("artists")),
                TrackInfo.pickImage(o.optJSONArray("artwork"), 512), true, true, null));
        }
        return out;
    }

    private static List<Node> artists(@Nullable JSONArray arr) {
        List<Node> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null || o.optString("id", "").isEmpty()) continue;
            String art = o.optString("image", "");
            if (art.isEmpty() || "null".equals(art)) art = TrackInfo.pickImage(o.optJSONArray("artwork"), 512);
            out.add(new Node(MediaIds.container(MediaIds.KIND_ARTIST, o.optString("id")), o.optString("name", ""), "", art, true, true, null));
        }
        return out;
    }
}
