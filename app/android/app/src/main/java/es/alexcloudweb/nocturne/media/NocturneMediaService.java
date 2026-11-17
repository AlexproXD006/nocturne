package es.alexcloudweb.nocturne.media;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaConstants;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionResult;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import es.alexcloudweb.nocturne.MainActivity;
import es.alexcloudweb.nocturne.R;

/**
 * Hosts the Media3 {@link MediaSession} behind the system media controls (notification shade,
 * quick panel, lock screen, Samsung Now Bar, Bluetooth, Wear/Auto).
 *
 * <p>The session wraps a {@link BridgePlayer}; state comes from JS via {@link MediaBridge}. Media3
 * itself posts the media notification and moves this service in/out of the foreground
 * ({@code mediaPlayback} type) as playback starts/pauses, catching Android 12+'s
 * ForegroundServiceStartNotAllowedException (reported to {@link Listener}).
 *
 * <p>Like / Shuffle / Repeat are custom {@link CommandButton}s set as media button preferences:
 * Android 13+ System UI renders them as PlaybackState custom actions next to prev/play/next.
 */
@OptIn(markerClass = UnstableApi.class)
public final class NocturneMediaService extends MediaSessionService implements MediaBridge.StateListener {
    private static final String TAG = "NocturneMedia";

    static final String ACTION_LIKE = "es.alexcloudweb.nocturne.media.LIKE";
    static final String ACTION_SHUFFLE = "es.alexcloudweb.nocturne.media.SHUFFLE";
    static final String ACTION_REPEAT = "es.alexcloudweb.nocturne.media.REPEAT";

    private static final SessionCommand LIKE = new SessionCommand(ACTION_LIKE, Bundle.EMPTY);
    private static final SessionCommand SHUFFLE = new SessionCommand(ACTION_SHUFFLE, Bundle.EMPTY);
    private static final SessionCommand REPEAT = new SessionCommand(ACTION_REPEAT, Bundle.EMPTY);

    @Nullable private MediaSession session;
    @Nullable private BridgePlayer player;
    @Nullable private String buttonsKey;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            player = new BridgePlayer(Looper.getMainLooper());
            // Keep the prev/next slots for prev/next even when one is unavailable (last track), so
            // the custom buttons don't jump around in the system player.
            Bundle extras = new Bundle();
            extras.putBoolean(MediaConstants.EXTRAS_KEY_SLOT_RESERVATION_SEEK_TO_PREV, true);
            extras.putBoolean(MediaConstants.EXTRAS_KEY_SLOT_RESERVATION_SEEK_TO_NEXT, true);
            MediaSession.Builder builder = new MediaSession.Builder(this, player)
                .setId("nocturne")
                .setCallback(new Callback())
                .setSessionExtras(extras)
                .setMediaButtonPreferences(buttonsFor(this, MediaBridge.current()));
            PendingIntent open = openAppIntent(this);
            if (open != null) builder.setSessionActivity(open);
            session = builder.build();
            buttonsKey = keyOf(MediaBridge.current());

            DefaultMediaNotificationProvider provider = new DefaultMediaNotificationProvider.Builder(this)
                .setChannelId("nocturne_playback")
                .setChannelName(R.string.nocturne_media_channel_name)
                .build();
            provider.setSmallIcon(R.drawable.ic_stat_nocturne);
            setMediaNotificationProvider(provider);
            setListener(new Listener() {
                @Override
                public void onForegroundServiceStartNotAllowedException() {
                    // Android 12+ refused to promote us (app in background without an exemption).
                    // Media3 keeps the session; the notification appears once a foreground start is allowed.
                    Log.w(TAG, "foreground service start not allowed; media notification deferred");
                }
            });
            MediaBridge.attach(this);
        } catch (Throwable t) {
            Log.e(TAG, "media session setup failed", t);
        }
    }

    @Nullable
    @Override
    public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onStateChanged(@Nullable NowPlayingState state) {
        BridgePlayer p = player;
        if (p != null) p.refresh();
        if (state == null) {
            // Nothing loaded any more: the (now empty) player hides the notification; leave the
            // foreground and stop once the plugin's controller has unbound.
            try {
                pauseAllPlayersAndStopSelf();
            } catch (Throwable t) {
                Log.w(TAG, "stop after clear failed", t);
            }
        }
        MediaSession s = session;
        String key = keyOf(state);
        if (s != null && !key.equals(buttonsKey)) {
            buttonsKey = key;
            try {
                s.setMediaButtonPreferences(buttonsFor(this, state));
            } catch (Throwable t) {
                Log.e(TAG, "setMediaButtonPreferences failed", t);
            }
        }
    }

    /**
     * Audio lives in the WebView, so a service restarted by the system without it (sticky restart
     * after process death) has nothing to control: never ask for that restart, and stop if it
     * happens anyway.
     */
    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        super.onStartCommand(intent, flags, startId);
        if (intent == null && MediaBridge.current() == null) stopSelf();
        return START_NOT_STICKY;
    }

    /** Swiping the app away destroys the WebView (and its audio): drop the controls with it. */
    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        try {
            MediaBridge.setState(null); // -> onStateChanged -> pauseAllPlayersAndStopSelf()
        } catch (Throwable t) {
            Log.e(TAG, "onTaskRemoved cleanup failed", t);
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        MediaBridge.detach(this);
        MediaSession s = session;
        session = null;
        if (s != null) {
            try {
                s.getPlayer().release();
                s.release();
            } catch (Throwable t) {
                Log.e(TAG, "session release failed", t);
            }
        }
        player = null;
        clearListener();
        super.onDestroy();
    }

    // ---------------------------------------------------------------------------------------------

    private static String keyOf(@Nullable NowPlayingState state) {
        return state == null ? "" : state.buttonsKey();
    }

    @Nullable
    private static PendingIntent openAppIntent(Context ctx) {
        try {
            Intent intent = new Intent(ctx, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            return PendingIntent.getActivity(ctx, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        } catch (Throwable t) {
            Log.w(TAG, "session activity intent unavailable", t);
            return null;
        }
    }

    /** Like, Shuffle, Repeat (in that order; stock Android 13+ shows the first two beside prev/next). */
    static ImmutableList<CommandButton> buttonsFor(Context ctx, @Nullable NowPlayingState s) {
        if (s == null) return ImmutableList.of();
        CommandButton like = new CommandButton.Builder(s.liked ? CommandButton.ICON_HEART_FILLED : CommandButton.ICON_HEART_UNFILLED)
            .setCustomIconResId(s.liked ? R.drawable.ic_media_heart_filled : R.drawable.ic_media_heart_outline)
            .setDisplayName(ctx.getString(s.liked ? R.string.nocturne_media_unlike : R.string.nocturne_media_like))
            .setSessionCommand(LIKE)
            .build();
        CommandButton shuffle = new CommandButton.Builder(s.shuffle ? CommandButton.ICON_SHUFFLE_ON : CommandButton.ICON_SHUFFLE_OFF)
            .setCustomIconResId(s.shuffle ? R.drawable.ic_media_shuffle_on : R.drawable.ic_media_shuffle_off)
            .setDisplayName(ctx.getString(s.shuffle ? R.string.nocturne_media_shuffle_on : R.string.nocturne_media_shuffle_off))
            .setSessionCommand(SHUFFLE)
            .build();
        int repeatIcon;
        int repeatRes;
        int repeatLabel;
        if (NowPlayingState.REPEAT_ALL.equals(s.repeat)) {
            repeatIcon = CommandButton.ICON_REPEAT_ALL;
            repeatRes = R.drawable.ic_media_repeat_all;
            repeatLabel = R.string.nocturne_media_repeat_all;
        } else if (NowPlayingState.REPEAT_ONE.equals(s.repeat)) {
            repeatIcon = CommandButton.ICON_REPEAT_ONE;
            repeatRes = R.drawable.ic_media_repeat_one;
            repeatLabel = R.string.nocturne_media_repeat_one;
        } else {
            repeatIcon = CommandButton.ICON_REPEAT_OFF;
            repeatRes = R.drawable.ic_media_repeat_off;
            repeatLabel = R.string.nocturne_media_repeat_off;
        }
        CommandButton repeat = new CommandButton.Builder(repeatIcon)
            .setCustomIconResId(repeatRes)
            .setDisplayName(ctx.getString(repeatLabel))
            .setSessionCommand(REPEAT)
            .build();
        return ImmutableList.of(like, shuffle, repeat);
    }

    private final class Callback implements MediaSession.Callback {
        @NonNull
        @Override
        public MediaSession.ConnectionResult onConnect(@NonNull MediaSession mediaSession, @NonNull MediaSession.ControllerInfo controller) {
            // Media3's defaults (narrower for untrusted controllers) plus our three buttons, for every
            // controller: OEM surfaces (Samsung quick panel / Now Bar) must be able to use them.
            MediaSession.ConnectionResult defaults =
                new MediaSession.ConnectionResult.AcceptedResultBuilder(mediaSession, controller).build();
            SessionCommands commands = defaults.availableSessionCommands.buildUpon()
                .add(LIKE)
                .add(SHUFFLE)
                .add(REPEAT)
                .build();
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(mediaSession, controller)
                .setAvailableSessionCommands(commands)
                .setMediaButtonPreferences(buttonsFor(NocturneMediaService.this, MediaBridge.current()))
                .build();
        }

        @NonNull
        @Override
        public ListenableFuture<SessionResult> onCustomCommand(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controller,
            @NonNull SessionCommand customCommand,
            @NonNull Bundle args
        ) {
            NowPlayingState s = MediaBridge.current();
            String action = customCommand.customAction;
            if (s == null) return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            // Flip the button at once (optimistic); JS answers with the authoritative state.
            if (ACTION_LIKE.equals(action)) {
                MediaBridge.setStateDeferred(s.withLiked(!s.liked));
                MediaBridge.dispatch("like", null);
            } else if (ACTION_SHUFFLE.equals(action)) {
                MediaBridge.setStateDeferred(s.withShuffle(!s.shuffle));
                MediaBridge.dispatch("shuffle", null);
            } else if (ACTION_REPEAT.equals(action)) {
                MediaBridge.setStateDeferred(s.withRepeat(NowPlayingState.nextRepeat(s.repeat)));
                MediaBridge.dispatch("repeat", null);
            } else {
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED));
            }
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
        }
    }
}
