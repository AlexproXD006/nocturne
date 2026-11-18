package es.alexcloudweb.nocturne.media;

import androidx.annotation.Nullable;
import org.json.JSONArray;
import org.json.JSONObject;

/** A song as the server sends it (Track), reduced to what the media service needs. */
final class TrackInfo {
    final String id;
    final String title;
    final String artist;
    final String album;
    final String artUrl;
    final long durationMs;
    final boolean liked;
    /** The raw Track JSON, handed to the WebView when it adopts a queue the car started. */
    final String json;

    private TrackInfo(String id, String title, String artist, String album, String artUrl, long durationMs, boolean liked, String json) {
        this.id = id;
        this.title = title;
        this.artist = artist;
        this.album = album;
        this.artUrl = artUrl;
        this.durationMs = durationMs;
        this.liked = liked;
        this.json = json;
    }

    @Nullable
    static TrackInfo from(@Nullable JSONObject o) {
        if (o == null) return null;
        String id = o.optString("id", "");
        if (id.isEmpty()) return null;
        JSONObject album = o.optJSONObject("album");
        return new TrackInfo(
            id,
            o.optString("title", ""),
            names(o.optJSONArray("artists")),
            album == null ? "" : album.optString("title", ""),
            pickImage(o.optJSONArray("artwork"), 512),
            (long) (o.optDouble("duration", 0) * 1000),
            o.optBoolean("liked", false),
            o.toString()
        );
    }

    static String names(@Nullable JSONArray artists) {
        if (artists == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < artists.length(); i++) {
            JSONObject a = artists.optJSONObject(i);
            String n = a == null ? "" : a.optString("name", "");
            if (n.isEmpty()) continue;
            if (sb.length() > 0) sb.append(", ");
            sb.append(n);
        }
        return sb.toString();
    }

    /** Smallest image at least {@code size} wide, else the largest (mirrors the app's pickImage). */
    static String pickImage(@Nullable JSONArray images, int size) {
        if (images == null) return "";
        String best = "";
        int bestW = -1;
        String largest = "";
        int largestW = -1;
        for (int i = 0; i < images.length(); i++) {
            JSONObject im = images.optJSONObject(i);
            if (im == null) continue;
            String url = im.optString("url", "");
            if (url.isEmpty()) continue;
            int w = im.optInt("width", 0);
            if (w >= size && (bestW < 0 || w < bestW)) {
                best = url;
                bestW = w;
            }
            if (w >= largestW) {
                largest = url;
                largestW = w;
            }
        }
        return best.isEmpty() ? largest : best;
    }
}
