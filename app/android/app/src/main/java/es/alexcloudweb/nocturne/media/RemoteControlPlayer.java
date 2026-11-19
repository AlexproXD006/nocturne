package es.alexcloudweb.nocturne.media;

import android.net.Uri;
import android.os.SystemClock;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.DeviceInfo;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import com.google.common.base.Objects;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * The player the media session sees. While Nocturne is not controlling another device it is a plain
 * pass-through to ExoPlayer (local playback, local system volume).
 *
 * <p>While controlling a Connect device (e.g. the PC), it presents that device instead: a single
 * mirrored media item with its metadata / state, a {@code PLAYBACK_TYPE_REMOTE} {@link DeviceInfo}
 * (so Android routes the hardware volume keys and the system volume slider, also on the lock screen,
 * to this session and labels it with the device name), and device-volume commands whose results go
 * back to the WebView through {@link Sink}. The local ExoPlayer is untouched (paused by the app).
 *
 * <p>Main thread only, like ExoPlayer.
 */
@OptIn(markerClass = UnstableApi.class)
final class RemoteControlPlayer extends ForwardingPlayer {
    /** Where user actions on the mirrored device go (the WebView, which owns Connect). */
    interface Sink {
        /** Volume 0..1. */
        void volume(double volume);
        void muted(boolean muted);
        /** play | pause | next | previous | seek (positionMs only for seek). */
        void transport(String action, long positionMs);
    }

    /** Immutable mirror of the controlled device. */
    static final class Remote {
        final String deviceName;
        final double volume;
        final boolean muted;
        /** idle | buffering | playing | paused */
        final String status;
        final long positionMs;
        final long durationMs;
        @Nullable final String trackId;
        final String title;
        final String artist;
        final String album;
        final String artworkUrl;

        Remote(String deviceName, double volume, boolean muted, String status, long positionMs, long durationMs,
               @Nullable String trackId, String title, String artist, String album, String artworkUrl) {
            this.deviceName = deviceName;
            this.volume = volume;
            this.muted = muted;
            this.status = status;
            this.positionMs = positionMs;
            this.durationMs = durationMs;
            this.trackId = trackId;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.artworkUrl = artworkUrl;
        }
    }

    private static final Player.Commands REMOTE_COMMANDS = new Player.Commands.Builder()
        .addAll(
            Player.COMMAND_PLAY_PAUSE,
            Player.COMMAND_PREPARE,
            Player.COMMAND_STOP,
            Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_NEXT,
            Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_PREVIOUS,
            Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
            Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
            Player.COMMAND_GET_TIMELINE,
            Player.COMMAND_GET_METADATA,
            Player.COMMAND_GET_AUDIO_ATTRIBUTES,
            Player.COMMAND_GET_DEVICE_VOLUME,
            Player.COMMAND_SET_DEVICE_VOLUME,
            Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS,
            Player.COMMAND_ADJUST_DEVICE_VOLUME,
            Player.COMMAND_ADJUST_DEVICE_VOLUME_WITH_FLAGS)
        .build();

    private final Sink sink;
    private final CopyOnWriteArrayList<Player.Listener> listeners = new CopyOnWriteArrayList<>();
    private final RemoteVolume volume = new RemoteVolume();

    @Nullable private Remote remote;
    private long remoteAtMs;
    private Timeline timeline = Timeline.EMPTY;
    @Nullable private MediaItem item;
    private long itemDurationMs = -1;

    RemoteControlPlayer(Player wrapped, Sink sink) {
        super(wrapped);
        this.sink = sink;
    }

    private static long now() {
        return SystemClock.elapsedRealtime();
    }

    boolean isRemote() {
        return remote != null;
    }

    // ---------------------------------------------------------------------------------------------
    // State in (from the WebView)
    // ---------------------------------------------------------------------------------------------

    /** Starts / updates mirroring. */
    void setRemote(Remote r) {
        Remote old = remote;
        MediaMetadata oldMeta = getMediaMetadata();
        Timeline oldTimeline = getCurrentTimeline();
        int oldState = getPlaybackState();
        boolean oldPlayWhen = getPlayWhenReady();
        boolean oldPlaying = isPlaying();
        DeviceInfo oldInfo = getDeviceInfo();
        int oldStep = getDeviceVolume();
        boolean oldMuted = isDeviceMuted();
        Player.Commands oldCommands = getAvailableCommands();
        MediaItem oldItem = getCurrentMediaItem();

        remote = r;
        remoteAtMs = now();
        volume.fromRemote(r.volume, r.muted, remoteAtMs);
        rebuildTimeline();

        boolean activated = old == null;
        if (activated || !Objects.equal(oldInfo, getDeviceInfo())) for (Player.Listener l : listeners) l.onDeviceInfoChanged(getDeviceInfo());
        if (activated || oldStep != getDeviceVolume() || oldMuted != isDeviceMuted()) {
            for (Player.Listener l : listeners) l.onDeviceVolumeChanged(getDeviceVolume(), isDeviceMuted());
        }
        if (activated || !oldCommands.equals(getAvailableCommands())) for (Player.Listener l : listeners) l.onAvailableCommandsChanged(getAvailableCommands());
        if (activated || !sameTimeline(oldTimeline, getCurrentTimeline())) {
            for (Player.Listener l : listeners) l.onTimelineChanged(getCurrentTimeline(), Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED);
        }
        if (activated || !Objects.equal(oldItem, getCurrentMediaItem())) {
            for (Player.Listener l : listeners) l.onMediaItemTransition(getCurrentMediaItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED);
        }
        if (activated || !oldMeta.equals(getMediaMetadata())) for (Player.Listener l : listeners) l.onMediaMetadataChanged(getMediaMetadata());
        if (activated || oldState != getPlaybackState()) for (Player.Listener l : listeners) l.onPlaybackStateChanged(getPlaybackState());
        if (activated || oldPlayWhen != getPlayWhenReady()) {
            for (Player.Listener l : listeners) l.onPlayWhenReadyChanged(getPlayWhenReady(), Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE);
        }
        if (activated || oldPlaying != isPlaying()) for (Player.Listener l : listeners) l.onIsPlayingChanged(isPlaying());
        fireEvents();
    }

    /** Back to local playback. */
    void clearRemote() {
        if (remote == null) return;
        remote = null;
        item = null;
        timeline = Timeline.EMPTY;
        for (Player.Listener l : listeners) {
            l.onDeviceInfoChanged(getDeviceInfo());
            l.onDeviceVolumeChanged(getDeviceVolume(), isDeviceMuted());
            l.onAvailableCommandsChanged(getAvailableCommands());
            l.onTimelineChanged(getCurrentTimeline(), Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED);
            l.onMediaItemTransition(getCurrentMediaItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED);
            l.onMediaMetadataChanged(getMediaMetadata());
            l.onPlaybackStateChanged(getPlaybackState());
            l.onPlayWhenReadyChanged(getPlayWhenReady(), Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE);
            l.onIsPlayingChanged(isPlaying());
        }
        fireEvents();
    }

    private void fireEvents() {
        androidx.media3.common.FlagSet flags = new androidx.media3.common.FlagSet.Builder()
            .addAll(Player.EVENT_DEVICE_INFO_CHANGED, Player.EVENT_DEVICE_VOLUME_CHANGED, Player.EVENT_AVAILABLE_COMMANDS_CHANGED,
                Player.EVENT_TIMELINE_CHANGED, Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_MEDIA_METADATA_CHANGED,
                Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_PLAY_WHEN_READY_CHANGED, Player.EVENT_IS_PLAYING_CHANGED)
            .build();
        Player.Events events = new Player.Events(flags);
        for (Player.Listener l : listeners) l.onEvents(this, events);
    }

    private static boolean sameTimeline(Timeline a, Timeline b) {
        return a == b || (a.isEmpty() && b.isEmpty());
    }

    private void rebuildTimeline() {
        Remote r = remote;
        if (r == null || r.trackId == null) {
            item = null;
            itemDurationMs = -1;
            timeline = Timeline.EMPTY;
            return;
        }
        MediaItem built = new MediaItem.Builder()
            .setMediaId("remote:" + r.trackId)
            .setMediaMetadata(metadataOf(r))
            .build();
        if (item != null && item.equals(built) && itemDurationMs == r.durationMs) return;
        item = built;
        itemDurationMs = r.durationMs;
        timeline = new SingleItemTimeline(built, r.durationMs > 0 ? r.durationMs * 1000 : C.TIME_UNSET);
    }

    private static MediaMetadata metadataOf(Remote r) {
        MediaMetadata.Builder b = new MediaMetadata.Builder()
            .setTitle(r.title)
            .setArtist(r.artist)
            .setAlbumTitle(r.album)
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC);
        if (!r.artworkUrl.isEmpty()) b.setArtworkUri(Uri.parse(r.artworkUrl));
        return b.build();
    }

    // ---------------------------------------------------------------------------------------------
    // Listeners (kept so remote changes can be dispatched; also registered on the wrapped player)
    // ---------------------------------------------------------------------------------------------

    @Override
    public void addListener(Player.Listener listener) {
        listeners.add(listener);
        super.addListener(listener);
    }

    @Override
    public void removeListener(Player.Listener listener) {
        listeners.remove(listener);
        super.removeListener(listener);
    }

    // ---------------------------------------------------------------------------------------------
    // Device volume
    // ---------------------------------------------------------------------------------------------

    @Override
    public DeviceInfo getDeviceInfo() {
        Remote r = remote;
        if (r == null) return super.getDeviceInfo();
        return new DeviceInfo.Builder(DeviceInfo.PLAYBACK_TYPE_REMOTE)
            .setMinVolume(0)
            .setMaxVolume(RemoteVolume.MAX_STEPS)
            .setRoutingControllerId(r.deviceName)
            .build();
    }

    @Override
    public int getDeviceVolume() {
        return remote == null ? super.getDeviceVolume() : volume.step();
    }

    @Override
    public boolean isDeviceMuted() {
        return remote == null ? super.isDeviceMuted() : volume.muted();
    }

    @Override
    public void setDeviceVolume(int v) {
        if (remote == null) {
            super.setDeviceVolume(v);
            return;
        }
        userVolume(v);
    }

    @Override
    public void setDeviceVolume(int v, int flags) {
        if (remote == null) {
            super.setDeviceVolume(v, flags);
            return;
        }
        userVolume(v);
    }

    @Override
    public void increaseDeviceVolume() {
        if (remote == null) {
            super.increaseDeviceVolume();
            return;
        }
        step(+1);
    }

    @Override
    public void increaseDeviceVolume(int flags) {
        if (remote == null) {
            super.increaseDeviceVolume(flags);
            return;
        }
        step(+1);
    }

    @Override
    public void decreaseDeviceVolume() {
        if (remote == null) {
            super.decreaseDeviceVolume();
            return;
        }
        step(-1);
    }

    @Override
    public void decreaseDeviceVolume(int flags) {
        if (remote == null) {
            super.decreaseDeviceVolume(flags);
            return;
        }
        step(-1);
    }

    @Override
    public void setDeviceMuted(boolean muted) {
        if (remote == null) {
            super.setDeviceMuted(muted);
            return;
        }
        userMute(muted);
    }

    @Override
    public void setDeviceMuted(boolean muted, int flags) {
        if (remote == null) {
            super.setDeviceMuted(muted, flags);
            return;
        }
        userMute(muted);
    }

    private void step(int delta) {
        // Raising the volume while muted unmutes, like on the PC itself.
        boolean wasMuted = volume.muted();
        if (wasMuted && delta > 0) userMute(false);
        userVolume(volume.step() + delta);
    }

    private void userVolume(int target) {
        boolean changed = volume.userSet(target, now());
        if (!changed) return;
        sink.volume(RemoteVolume.fromStep(volume.step()));
        for (Player.Listener l : listeners) l.onDeviceVolumeChanged(volume.step(), volume.muted());
    }

    private void userMute(boolean muted) {
        if (!volume.userMute(muted, now())) return;
        sink.muted(muted);
        for (Player.Listener l : listeners) l.onDeviceVolumeChanged(volume.step(), volume.muted());
    }

    // ---------------------------------------------------------------------------------------------
    // Mirrored playback state
    // ---------------------------------------------------------------------------------------------

    @Override
    public Player.Commands getAvailableCommands() {
        return remote == null ? super.getAvailableCommands() : REMOTE_COMMANDS;
    }

    @Override
    public boolean isCommandAvailable(int command) {
        return remote == null ? super.isCommandAvailable(command) : REMOTE_COMMANDS.contains(command);
    }

    @Override
    public Timeline getCurrentTimeline() {
        return remote == null ? super.getCurrentTimeline() : timeline;
    }

    @Override
    @Nullable
    public MediaItem getCurrentMediaItem() {
        return remote == null ? super.getCurrentMediaItem() : item;
    }

    @Override
    public int getMediaItemCount() {
        return remote == null ? super.getMediaItemCount() : (item == null ? 0 : 1);
    }

    @Override
    public MediaItem getMediaItemAt(int index) {
        if (remote == null || item == null) return super.getMediaItemAt(index);
        return item;
    }

    @Override
    public int getCurrentMediaItemIndex() {
        return remote == null ? super.getCurrentMediaItemIndex() : 0;
    }

    @Override
    public int getCurrentPeriodIndex() {
        return remote == null ? super.getCurrentPeriodIndex() : 0;
    }

    @Override
    public MediaMetadata getMediaMetadata() {
        Remote r = remote;
        return r == null ? super.getMediaMetadata() : (r.trackId == null ? MediaMetadata.EMPTY : metadataOf(r));
    }

    @Override
    public int getPlaybackState() {
        Remote r = remote;
        if (r == null) return super.getPlaybackState();
        if (r.trackId == null || "idle".equals(r.status)) return Player.STATE_IDLE;
        return "buffering".equals(r.status) ? Player.STATE_BUFFERING : Player.STATE_READY;
    }

    @Override
    public boolean getPlayWhenReady() {
        Remote r = remote;
        return r == null ? super.getPlayWhenReady() : "playing".equals(r.status) || "buffering".equals(r.status);
    }

    @Override
    public boolean isPlaying() {
        Remote r = remote;
        return r == null ? super.isPlaying() : "playing".equals(r.status);
    }

    @Override
    public long getCurrentPosition() {
        Remote r = remote;
        if (r == null) return super.getCurrentPosition();
        long p = r.positionMs + ("playing".equals(r.status) ? Math.max(0, now() - remoteAtMs) : 0);
        return r.durationMs > 0 ? Math.min(p, r.durationMs) : p;
    }

    @Override
    public long getContentPosition() {
        return remote == null ? super.getContentPosition() : getCurrentPosition();
    }

    @Override
    public long getBufferedPosition() {
        return remote == null ? super.getBufferedPosition() : getCurrentPosition();
    }

    @Override
    public long getContentBufferedPosition() {
        return remote == null ? super.getContentBufferedPosition() : getCurrentPosition();
    }

    @Override
    public long getDuration() {
        Remote r = remote;
        return r == null ? super.getDuration() : (r.durationMs > 0 ? r.durationMs : C.TIME_UNSET);
    }

    @Override
    public long getContentDuration() {
        return remote == null ? super.getContentDuration() : getDuration();
    }

    @Override
    public boolean isCurrentMediaItemSeekable() {
        return remote == null ? super.isCurrentMediaItemSeekable() : item != null;
    }

    @Override
    public boolean isCurrentMediaItemDynamic() {
        return remote == null && super.isCurrentMediaItemDynamic();
    }

    @Override
    public boolean isCurrentMediaItemLive() {
        return remote == null && super.isCurrentMediaItemLive();
    }

    @Override
    public boolean hasNextMediaItem() {
        return remote == null ? super.hasNextMediaItem() : item != null;
    }

    @Override
    public boolean hasPreviousMediaItem() {
        return remote == null ? super.hasPreviousMediaItem() : item != null;
    }

    // ---------------------------------------------------------------------------------------------
    // Transport while mirroring: goes to the controlled device, never to local ExoPlayer
    // ---------------------------------------------------------------------------------------------

    @Override
    public void play() {
        if (remote == null) super.play();
        else sink.transport("play", 0);
    }

    @Override
    public void pause() {
        if (remote == null) super.pause();
        else sink.transport("pause", 0);
    }

    @Override
    public void setPlayWhenReady(boolean playWhenReady) {
        if (remote == null) super.setPlayWhenReady(playWhenReady);
        else sink.transport(playWhenReady ? "play" : "pause", 0);
    }

    @Override
    public void prepare() {
        if (remote == null) super.prepare();
    }

    @Override
    public void stop() {
        if (remote == null) super.stop();
        else sink.transport("pause", 0);
    }

    @Override
    public void seekToNext() {
        if (remote == null) super.seekToNext();
        else sink.transport("next", 0);
    }

    @Override
    public void seekToNextMediaItem() {
        if (remote == null) super.seekToNextMediaItem();
        else sink.transport("next", 0);
    }

    @Override
    public void seekToPrevious() {
        if (remote == null) super.seekToPrevious();
        else sink.transport("previous", 0);
    }

    @Override
    public void seekToPreviousMediaItem() {
        if (remote == null) super.seekToPreviousMediaItem();
        else sink.transport("previous", 0);
    }

    @Override
    public void seekTo(long positionMs) {
        if (remote == null) super.seekTo(positionMs);
        else sink.transport("seek", Math.max(0, positionMs));
    }

    @Override
    public void seekTo(int mediaItemIndex, long positionMs) {
        if (remote == null) super.seekTo(mediaItemIndex, positionMs);
        else sink.transport("seek", Math.max(0, positionMs));
    }

    /** One window, one period: the mirrored remote track. */
    private static final class SingleItemTimeline extends Timeline {
        private static final Object UID = new Object();
        private final MediaItem mediaItem;
        private final long durationUs;

        SingleItemTimeline(MediaItem mediaItem, long durationUs) {
            this.mediaItem = mediaItem;
            this.durationUs = durationUs;
        }

        @Override
        public int getWindowCount() {
            return 1;
        }

        @Override
        public Window getWindow(int windowIndex, Window window, long defaultPositionProjectionUs) {
            return window.set(UID, mediaItem, null, C.TIME_UNSET, C.TIME_UNSET, C.TIME_UNSET, true, false, null, 0, durationUs, 0, 0, 0);
        }

        @Override
        public int getPeriodCount() {
            return 1;
        }

        @Override
        public Period getPeriod(int periodIndex, Period period, boolean setIds) {
            return period.set(setIds ? UID : null, setIds ? UID : null, 0, durationUs, 0);
        }

        @Override
        public int getIndexOfPeriod(Object uid) {
            return UID.equals(uid) ? 0 : C.INDEX_UNSET;
        }

        @Override
        public Object getUidOfPeriod(int periodIndex) {
            return UID;
        }
    }
}
