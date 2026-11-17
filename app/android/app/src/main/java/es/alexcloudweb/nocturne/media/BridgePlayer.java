package es.alexcloudweb.nocturne.media;

import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.SimpleBasePlayer;
import androidx.media3.common.util.UnstableApi;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

/**
 * A Media3 {@link Player} that plays nothing: audio comes from the WebView's HTML audio element.
 *
 * <p>State in: {@link #getState()} mirrors the latest {@link NowPlayingState} from JS as a
 * one-item playlist (metadata + artworkUri, duration, position, playWhenReady). While playing, the
 * content position is an extrapolating supplier anchored at the time JS reported it, with speed
 * 1.0, so the session's PlaybackState advances the system seek bar on its own and freezes when
 * paused.
 *
 * <p>Commands out: every {@code handle*} call is forwarded to JS through {@link MediaBridge};
 * next/previous are recognised by the seek command, not by playlist index, because the playlist
 * only ever holds the current track.
 */
@OptIn(markerClass = UnstableApi.class)
final class BridgePlayer extends SimpleBasePlayer {
    private static final String TAG = "NocturneMedia";

    private static final AudioAttributes MUSIC = new AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
        .build();

    private static final Commands IDLE_COMMANDS = new Commands.Builder()
        .addAll(COMMAND_GET_AUDIO_ATTRIBUTES, COMMAND_GET_TIMELINE, COMMAND_GET_METADATA, COMMAND_RELEASE)
        .build();

    BridgePlayer(Looper looper) {
        super(looper);
    }

    /** Re-reads the bridge state and informs the session. Main thread only; never throws. */
    void refresh() {
        try {
            invalidateState();
        } catch (Throwable t) {
            Log.e(TAG, "invalidateState failed", t);
        }
    }

    @NonNull
    @Override
    protected State getState() {
        NowPlayingState s = MediaBridge.current();
        State.Builder b = new State.Builder()
            .setAudioAttributes(MUSIC)
            .setPlaybackParameters(PlaybackParameters.DEFAULT);
        if (s == null) {
            return b.setAvailableCommands(IDLE_COMMANDS)
                .setPlaylist(ImmutableList.of())
                .setPlaybackState(STATE_IDLE)
                .setPlayWhenReady(false, PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                .setContentPositionMs(0)
                .build();
        }

        boolean seekable = s.durationMs > 0;
        Commands.Builder commands = new Commands.Builder().addAll(
            COMMAND_PLAY_PAUSE,
            COMMAND_PREPARE,
            COMMAND_STOP,
            COMMAND_RELEASE,
            COMMAND_GET_CURRENT_MEDIA_ITEM,
            COMMAND_GET_TIMELINE,
            COMMAND_GET_METADATA,
            COMMAND_GET_AUDIO_ATTRIBUTES,
            COMMAND_SET_SHUFFLE_MODE,
            COMMAND_SET_REPEAT_MODE,
            // "Previous" restarts the track when nothing precedes it (like Spotify), so it is always on.
            COMMAND_SEEK_TO_PREVIOUS
        );
        if (seekable) commands.addAll(COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, COMMAND_SEEK_TO_DEFAULT_POSITION);
        if (s.hasPrev) commands.add(COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM);
        if (s.hasNext) commands.addAll(COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_NEXT_MEDIA_ITEM);

        MediaMetadata.Builder md = new MediaMetadata.Builder()
            .setTitle(s.title)
            .setDisplayTitle(s.title)
            .setArtist(s.artist)
            .setAlbumTitle(s.album)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .setIsPlayable(true)
            .setIsBrowsable(false);
        if (s.artworkUri != null) md.setArtworkUri(s.artworkUri);
        if (seekable) md.setDurationMs(s.durationMs);

        MediaItem mediaItem = new MediaItem.Builder()
            .setMediaId(s.uid)
            .setMediaMetadata(md.build())
            .build();
        MediaItemData item = new MediaItemData.Builder(s.uid)
            .setMediaItem(mediaItem)
            .setDurationUs(seekable ? s.durationMs * 1000L : C.TIME_UNSET)
            .setIsSeekable(seekable)
            .build();

        final NowPlayingState snapshot = s;
        PositionSupplier position = s.isAdvancing()
            ? snapshot::currentPositionMs
            : PositionSupplier.getConstant(s.currentPositionMs());

        return b.setAvailableCommands(commands.build())
            .setPlaylist(ImmutableList.of(item))
            .setCurrentMediaItemIndex(0)
            .setPlaybackState(s.buffering ? STATE_BUFFERING : STATE_READY)
            .setPlayWhenReady(s.playing, PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setContentPositionMs(position)
            .setShuffleModeEnabled(s.shuffle)
            .setRepeatMode(repeatModeOf(s.repeat))
            .build();
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleSetPlayWhenReady(boolean playWhenReady) {
        NowPlayingState s = MediaBridge.current();
        if (s != null) {
            MediaBridge.setStateQuietly(s.withPlaying(playWhenReady));
            MediaBridge.dispatch(playWhenReady ? "play" : "pause", null);
        }
        return Futures.immediateVoidFuture();
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handlePrepare() {
        return Futures.immediateVoidFuture();
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleStop() {
        NowPlayingState s = MediaBridge.current();
        if (s != null) {
            MediaBridge.setStateQuietly(s.withPlaying(false));
            MediaBridge.dispatch("stop", null);
        }
        return Futures.immediateVoidFuture();
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleRelease() {
        return Futures.immediateVoidFuture();
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleSeek(int mediaItemIndex, long positionMs, @Player.Command int seekCommand) {
        NowPlayingState s = MediaBridge.current();
        if (s == null) return Futures.immediateVoidFuture();
        switch (seekCommand) {
            case COMMAND_SEEK_TO_NEXT:
            case COMMAND_SEEK_TO_NEXT_MEDIA_ITEM:
                MediaBridge.dispatch("next", null);
                break;
            case COMMAND_SEEK_TO_PREVIOUS:
            case COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM:
                MediaBridge.dispatch("previous", null);
                break;
            default: {
                // In-track seek (seek bar drag, Bluetooth scrub, seek to default position).
                long target = positionMs == C.TIME_UNSET ? 0L : Math.max(0L, positionMs);
                NowPlayingState next = s.withPosition(target);
                MediaBridge.setStateQuietly(next);
                MediaBridge.dispatch("seekTo", next.positionMs / 1000d);
                break;
            }
        }
        return Futures.immediateVoidFuture();
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleSetShuffleModeEnabled(boolean shuffleModeEnabled) {
        NowPlayingState s = MediaBridge.current();
        if (s != null && s.shuffle != shuffleModeEnabled) {
            MediaBridge.setStateDeferred(s.withShuffle(shuffleModeEnabled));
            MediaBridge.dispatch("shuffle", null);
        }
        return Futures.immediateVoidFuture();
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleSetRepeatMode(@RepeatMode int repeatMode) {
        NowPlayingState s = MediaBridge.current();
        if (s == null) return Futures.immediateVoidFuture();
        String target = repeatModeName(repeatMode);
        // JS only knows "cycle", so step off -> all -> one until the requested mode is reached.
        String mode = s.repeat;
        for (int i = 0; i < 3 && !mode.equals(target); i++) {
            mode = NowPlayingState.nextRepeat(mode);
            MediaBridge.dispatch("repeat", null);
        }
        if (!mode.equals(s.repeat)) MediaBridge.setStateDeferred(s.withRepeat(mode));
        return Futures.immediateVoidFuture();
    }

    static @RepeatMode int repeatModeOf(String repeat) {
        if (NowPlayingState.REPEAT_ALL.equals(repeat)) return REPEAT_MODE_ALL;
        if (NowPlayingState.REPEAT_ONE.equals(repeat)) return REPEAT_MODE_ONE;
        return REPEAT_MODE_OFF;
    }

    static String repeatModeName(@RepeatMode int mode) {
        if (mode == REPEAT_MODE_ALL) return NowPlayingState.REPEAT_ALL;
        if (mode == REPEAT_MODE_ONE) return NowPlayingState.REPEAT_ONE;
        return NowPlayingState.REPEAT_OFF;
    }
}
