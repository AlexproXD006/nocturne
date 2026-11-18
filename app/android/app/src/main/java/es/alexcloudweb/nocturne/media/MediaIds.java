package es.alexcloudweb.nocturne.media;

import androidx.annotation.Nullable;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.net.URLEncoder;

/**
 * Media ids of the Android Auto browse tree. Pure Java (unit-tested).
 *
 * <pre>
 * root                      browse root
 * mixes | playlists | liked | recent | albums | artists     the six top level nodes
 * mix:ID | playlist:ID | album:ID | artist:ID               containers (browsable and playable)
 * track:ID|CTX              a song listed inside the container CTX (CTX is liked, recent, mix:ID, ...)
 * </pre>
 *
 * Playing a track makes the whole container its queue, so the id carries the container.
 */
final class MediaIds {
    static final String ROOT = "root";
    static final String MIXES = "mixes";
    static final String PLAYLISTS = "playlists";
    static final String LIKED = "liked";
    static final String RECENT = "recent";
    static final String ALBUMS = "albums";
    static final String ARTISTS = "artists";

    static final String KIND_TRACK = "track";
    static final String KIND_MIX = "mix";
    static final String KIND_PLAYLIST = "playlist";
    static final String KIND_ALBUM = "album";
    static final String KIND_ARTIST = "artist";
    static final String KIND_SEARCH = "search";

    /** Most items one browse node returns (Android Auto lists get unusable beyond this). */
    static final int MAX_PAGE = 100;

    private MediaIds() {}

    static final class Parsed {
        /** track, mix, playlist, album, artist, search, or the bare id of a tab / root. */
        final String kind;
        /** Decoded id (empty for tabs and root). */
        final String id;
        /** Container of a track id (e.g. {@code playlist:42}), else empty. */
        final String ctx;

        Parsed(String kind, String id, String ctx) {
            this.kind = kind;
            this.id = id;
            this.ctx = ctx;
        }
    }

    static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    static String dec(String s) {
        try {
            return URLDecoder.decode(s, "UTF-8");
        } catch (UnsupportedEncodingException | IllegalArgumentException e) {
            return s;
        }
    }

    static String container(String kind, String id) {
        return kind + ":" + enc(id);
    }

    static String track(String trackId, @Nullable String ctx) {
        return KIND_TRACK + ":" + enc(trackId) + "|" + (ctx == null ? "" : ctx);
    }

    static Parsed parse(@Nullable String mediaId) {
        if (mediaId == null) return new Parsed("", "", "");
        int colon = mediaId.indexOf(':');
        if (colon < 0) return new Parsed(mediaId, "", "");
        String kind = mediaId.substring(0, colon);
        String rest = mediaId.substring(colon + 1);
        if (KIND_TRACK.equals(kind)) {
            int bar = rest.indexOf('|');
            String id = bar < 0 ? rest : rest.substring(0, bar);
            String ctx = bar < 0 ? "" : rest.substring(bar + 1);
            return new Parsed(kind, dec(id), ctx);
        }
        return new Parsed(kind, dec(rest), "");
    }

    /** {offset, limit} of a Media3 (page, pageSize) request, limit capped at {@link #MAX_PAGE}. */
    static int[] window(int page, int pageSize) {
        int size = pageSize <= 0 ? MAX_PAGE : Math.min(pageSize, MAX_PAGE);
        int p = Math.max(0, page);
        return new int[] { p * size, size };
    }

    /** Slice [offset, offset+limit) of an in-memory list size. Returns {from, to}. */
    static int[] slice(int total, int[] window) {
        int from = Math.min(Math.max(0, window[0]), total);
        int to = Math.min(total, from + window[1]);
        return new int[] { from, to };
    }
}
