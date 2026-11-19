package es.alexcloudweb.nocturne.widget;

import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** What the widgets show: the current song, play state, progress, lyric line and the next songs. Immutable. */
public final class WidgetState {
    public static final WidgetState EMPTY = new Builder().build();

    public final boolean hasQueue;
    public final String trackId;
    public final String title;
    public final String artist;
    public final String artUrl;
    public final boolean playing;
    public final boolean liked;
    public final long positionMs;
    public final long durationMs;
    /** Current synced lyric line, "" when none. */
    public final String lyric;
    /** "Title · Artist" of the next songs (at most 3). */
    public final List<String> upNext;

    private WidgetState(Builder b) {
        hasQueue = b.hasQueue;
        trackId = b.trackId;
        title = b.title;
        artist = b.artist;
        artUrl = b.artUrl;
        playing = b.playing;
        liked = b.liked;
        positionMs = Math.max(0, b.positionMs);
        durationMs = Math.max(0, b.durationMs);
        lyric = b.lyric;
        upNext = Collections.unmodifiableList(new ArrayList<>(b.upNext.subList(0, Math.min(3, b.upNext.size()))));
    }

    /** Progress 0..max (max = 1000) for a ProgressBar. */
    public int progress(int max) {
        if (durationMs <= 0) return 0;
        return (int) Math.min(max, Math.max(0, positionMs * max / durationMs));
    }

    public WidgetState withProgress(long positionMs, long durationMs, String lyric) {
        return toBuilder().position(positionMs, durationMs).lyric(lyric).build();
    }

    public WidgetState withLiked(boolean liked) {
        return toBuilder().liked(liked).build();
    }

    public Builder toBuilder() {
        Builder b = new Builder();
        b.hasQueue = hasQueue;
        b.trackId = trackId;
        b.title = title;
        b.artist = artist;
        b.artUrl = artUrl;
        b.playing = playing;
        b.liked = liked;
        b.positionMs = positionMs;
        b.durationMs = durationMs;
        b.lyric = lyric;
        b.upNext = new ArrayList<>(upNext);
        return b;
    }

    public static final class Builder {
        boolean hasQueue;
        String trackId = "";
        String title = "";
        String artist = "";
        String artUrl = "";
        boolean playing;
        boolean liked;
        long positionMs;
        long durationMs;
        String lyric = "";
        List<String> upNext = new ArrayList<>();

        public Builder queue(boolean hasQueue) {
            this.hasQueue = hasQueue;
            return this;
        }

        public Builder track(@Nullable String id, @Nullable String title, @Nullable String artist, @Nullable String artUrl) {
            this.trackId = id == null ? "" : id;
            this.title = title == null ? "" : title;
            this.artist = artist == null ? "" : artist;
            this.artUrl = artUrl == null ? "" : artUrl;
            return this;
        }

        public Builder playing(boolean playing) {
            this.playing = playing;
            return this;
        }

        public Builder liked(boolean liked) {
            this.liked = liked;
            return this;
        }

        public Builder position(long positionMs, long durationMs) {
            this.positionMs = positionMs;
            this.durationMs = durationMs;
            return this;
        }

        public Builder lyric(@Nullable String lyric) {
            this.lyric = lyric == null ? "" : lyric;
            return this;
        }

        public Builder next(String title, String artist) {
            String line = artist == null || artist.isEmpty() ? title : title + " · " + artist;
            if (upNext.size() < 3 && line != null && !line.isEmpty()) upNext.add(line);
            return this;
        }

        public WidgetState build() {
            return new WidgetState(this);
        }
    }
}
