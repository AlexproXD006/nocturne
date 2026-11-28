package es.alexcloudweb.nocturne.media;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import es.alexcloudweb.nocturne.diag.AppLog;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaConstants;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionError;
import androidx.media3.session.SessionResult;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.ListeningExecutorService;
import com.google.common.util.concurrent.MoreExecutors;
import es.alexcloudweb.nocturne.MainActivity;
import es.alexcloudweb.nocturne.R;
import es.alexcloudweb.nocturne.widget.WidgetState;
import es.alexcloudweb.nocturne.widget.WidgetUpdater;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Nocturne's playback engine and its Android Auto / system media browser.
 *
 * <p>ExoPlayer runs here (foreground service, audio focus, becoming-noisy, wake lock, gapless), not in
 * the WebView. The WebView is a remote UI: {@link NocturneMediaPlugin} forwards its queue and transport
 * commands through {@link EventHub}, and this service reports state back as events. Stream URLs are
 * resolved lazily with the stored session ({@link NocturneApi}), so the service also works when the app
 * process was cold-started by Android Auto with the phone locked.
 *
 * <p>The {@link MediaLibrarySession} exposes the browse tree ({@link Library}), voice search, and the
 * Like / Shuffle / Repeat buttons.
 */
@OptIn(markerClass = UnstableApi.class)
public final class NocturneMediaService extends MediaLibraryService {
    private static final String TAG = "NocturneMedia";

    static final String ACTION_LIKE = "es.alexcloudweb.nocturne.media.LIKE";
    static final String ACTION_SHUFFLE = "es.alexcloudweb.nocturne.media.SHUFFLE";
    static final String ACTION_REPEAT = "es.alexcloudweb.nocturne.media.REPEAT";

    private static final SessionCommand LIKE = new SessionCommand(ACTION_LIKE, Bundle.EMPTY);
    private static final SessionCommand SHUFFLE = new SessionCommand(ACTION_SHUFFLE, Bundle.EMPTY);
    private static final SessionCommand REPEAT = new SessionCommand(ACTION_REPEAT, Bundle.EMPTY);

    private static final long TICK_MS = 1000;
    /** How often the session (queue + position) is saved while playing. */
    private static final long PERSIST_MS = 5000;
    private long lastPersistAt;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ListeningExecutorService io = MoreExecutors.listeningDecorator(Executors.newFixedThreadPool(3));
    private final Map<String, String> trackJson = new HashMap<>();
    private final Set<String> likedIds = ConcurrentHashMap.newKeySet();
    private final ListenTracker listen = new ListenTracker();
    private final Map<String, List<Library.Node>> searchResults = new ConcurrentHashMap<>();

    @Nullable private ExoPlayer player;
    @Nullable private MediaLibrarySession session;
    /** What the session sees: local ExoPlayer, or the mirrored Connect device while this phone controls one. */
    @Nullable private RemoteControlPlayer remotePlayer;
    @Nullable private NocturneApi api;
    @Nullable private Library library;
    @Nullable private PlayReporter reporter;
    @Nullable private OfflineCache offline;
    /** Prefetch of the next queued track in progress (cancelled when the item changes). */
    @Nullable private volatile androidx.media3.datasource.cache.CacheWriter prefetch;

    private String lastStatus = "";
    private String buttonsKey = "";
    @Nullable private String currentUid;
    @Nullable private String retriedUid;
    /** Consecutive failed tracks skipped automatically; playback stops after MAX_AUTO_SKIPS. */
    private int errorStreak;
    private static final int MAX_AUTO_SKIPS = 2;
    private boolean externalQueuePending;
    private boolean shuffleOn;
    private String contextName = "";
    private final java.util.concurrent.atomic.AtomicLong uidCounter = new java.util.concurrent.atomic.AtomicLong();

    /** The 10-band equalizer (see EqAudioProcessor); fed by the plugin's setEq and by the persisted state. */
    private final EqAudioProcessor eqProcessor = new EqAudioProcessor();

    // Lyrics line in the car (off by default).
    private boolean lyricsEnabled;
    @Nullable private LrcParser lrc;
    private String lrcTrackId = "";
    private int lastLyricIdx = -2;
    private long lastLyricAt;

    // Home-screen widgets (see the widget package): state pushes and the large widget's lyric line.
    @Nullable private WidgetUpdater widgets;
    private String widgetLine = "";
    private final Runnable widgetPush = () -> pushWidgets(false);

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            tick();
            ExoPlayer p = player;
            if (p != null && p.getPlayWhenReady() && p.getPlaybackState() != Player.STATE_ENDED && p.getPlaybackState() != Player.STATE_IDLE) {
                main.postDelayed(this, TICK_MS);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            api = NocturneApi.get(this);
            library = new Library(api);
            library.setDownloads(() -> DownloadsController.get(this).completedTracks());
            reporter = new PlayReporter(this, api);
            api.setListener(session -> {
                // The refresh token rotated: tell the WebView so it does not keep a dead one.
                try {
                    JSONObject e = new JSONObject().put("type", "auth").put("session", session.toJson());
                    EventHub.emit(e);
                } catch (JSONException ignored) {
                    /* never */
                }
            });
            // Playback reads through the shared SimpleCache (key = track id): what is played is cached as it
            // streams (no second download), and a cached track plays with no network. Signed URLs are only
            // resolved on a cache miss.
            offline = OfflineCache.get(this);
            final androidx.media3.datasource.cache.CacheDataSource.Factory dataSources = offline.dataSources();
            // Equalizer: a custom AudioProcessor inside the DefaultAudioSink. Its last state is persisted natively
            // (EqPrefs) so it applies on a cold start (app closed, Android Auto) before any JS runs.
            eqProcessor.setState(EqPrefs.load(this));
            final Context appCtx = this;
            DefaultRenderersFactory renderers = new DefaultRenderersFactory(this) {
                @Override
                protected AudioSink buildAudioSink(Context context, boolean enableFloatOutput, boolean enableAudioTrackPlaybackParams) {
                    return new DefaultAudioSink.Builder(appCtx)
                        .setEnableFloatOutput(enableFloatOutput)
                        .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                        .setAudioProcessors(new AudioProcessor[] {eqProcessor})
                        .build();
                }
            };
            ExoPlayer p = new ExoPlayer.Builder(this, renderers)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSources))
                .setAudioAttributes(
                    new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                    /* handleAudioFocus= */ true)
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .build();
            restoreSession(p);
            p.addListener(new PlayerEvents());
            player = p;

            Bundle extras = new Bundle();
            extras.putBoolean(MediaConstants.EXTRAS_KEY_SLOT_RESERVATION_SEEK_TO_PREV, true);
            extras.putBoolean(MediaConstants.EXTRAS_KEY_SLOT_RESERVATION_SEEK_TO_NEXT, true);
            remotePlayer = new RemoteControlPlayer(p, new RemoteControlPlayer.Sink() {
                @Override
                public void volume(double v) {
                    emitRemote(new JSONObject(), "remoteVolume", "volume", v);
                }

                @Override
                public void muted(boolean m) {
                    emitRemote(new JSONObject(), "remoteMuted", "muted", m);
                }

                @Override
                public void transport(String action, long positionMs) {
                    try {
                        EventHub.emit(new JSONObject().put("type", "remoteTransport").put("action", action).put("position", positionMs / 1000.0));
                    } catch (JSONException ignored) {
                        /* never */
                    }
                }
            });
            MediaLibrarySession.Builder builder = new MediaLibrarySession.Builder(this, remotePlayer, new Callback())
                .setId("nocturne")
                .setSessionExtras(extras)
                .setMediaButtonPreferences(buttons());
            PendingIntent open = openAppIntent(this);
            if (open != null) builder.setSessionActivity(open);
            session = builder.build();

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
                    AppLog.w(TAG, "foreground service start not allowed; media notification deferred");
                }
            });
            buttonsKey = buttonsKey();
            lyricsEnabled = LyricsPref.get(this);
            reporter.flush();
            widgets = WidgetUpdater.get(this);
            EventHub.attach(this);
            scheduleWidgets();
        } catch (Throwable t) {
            AppLog.e(TAG, "media service setup failed", t);
        }
    }

    @Nullable
    @Override
    public MediaLibrarySession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        super.onStartCommand(intent, flags, startId);
        ExoPlayer p = player;
        if (intent == null && (p == null || p.getMediaItemCount() == 0)) stopSelf();
        return START_NOT_STICKY;
    }

    /** Swiping the app away keeps music playing (it lives here now); an idle service just stops. */
    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        persistSession();
        ExoPlayer p = player;
        if (p == null || !p.getPlayWhenReady() || p.getMediaItemCount() == 0) {
            try {
                pauseAllPlayersAndStopSelf();
            } catch (Throwable t) {
                AppLog.w(TAG, "stop after task removal failed", t);
                stopSelf();
            }
        }
    }

    @Override
    public void onDestroy() {
        persistSession();
        main.removeCallbacks(widgetPush);
        pushWidgets(true); // the widgets keep showing the last song, paused (play restores the session)
        EventHub.detach(this);
        EventHub.dropPending();
        main.removeCallbacksAndMessages(null);
        finishListen();
        if (api != null) api.setListener(null);
        MediaLibrarySession s = session;
        session = null;
        ExoPlayer p = player;
        player = null;
        try {
            if (s != null) s.release();
            if (p != null) p.release();
        } catch (Throwable t) {
            AppLog.e(TAG, "release failed", t);
        }
        cancelPrefetch();
        io.shutdown();
        super.onDestroy();
    }

    // ---------------------------------------------------------------------------------------------
    // Commands from the WebView (main thread)
    // ---------------------------------------------------------------------------------------------

    /** Aligns the ExoPlayer playlist with the WebView's queue; keeps the current item playing when it is still there. */
    void cmdSetQueue(List<MediaItem> itemsIn, int index, @Nullable Boolean play, long startMs, boolean reset) {
        ExoPlayer p = player;
        if (p == null || itemsIn.isEmpty()) return;
        final List<MediaItem> items = withOfflineArt(itemsIn);
        int target = Math.min(Math.max(0, index), items.size() - 1);
        String targetUid = items.get(target).mediaId;
        MediaItem cur = p.getCurrentMediaItem();
        int curInNew = cur == null ? -1 : indexOfId(items, cur.mediaId);
        if (curInNew >= 0) {
            if (!sameIds(p, items)) alignAround(p, items, curInNew);
            assert cur != null;
            if (!targetUid.equals(cur.mediaId)) {
                int at = indexInPlayer(p, targetUid);
                if (at >= 0) p.seekTo(at, startMs);
            } else if (reset) {
                p.seekTo(startMs);
            }
        } else {
            p.setMediaItems(items, target, startMs);
        }
        if (play != null) p.setPlayWhenReady(play);
        if (p.getPlaybackState() == Player.STATE_IDLE) p.prepare();
        lastStatus = "";
        emitState();
        refreshButtons();
        startTicker();
        persistSession();
        scheduleWidgets();
    }

    void cmdPlay() {
        ExoPlayer p = player;
        if (p == null || p.getMediaItemCount() == 0) return;
        if (p.getPlaybackState() == Player.STATE_ENDED) p.seekTo(p.getCurrentMediaItemIndex(), 0);
        p.setPlayWhenReady(true);
        if (p.getPlaybackState() == Player.STATE_IDLE) p.prepare();
        startTicker();
    }

    void cmdPause() {
        ExoPlayer p = player;
        if (p != null) p.setPlayWhenReady(false);
    }

    void cmdSeek(double seconds) {
        ExoPlayer p = player;
        if (p == null || p.getMediaItemCount() == 0) return;
        p.seekTo(Math.max(0, (long) (seconds * 1000)));
        emitPosition();
    }

    private static void emitRemote(JSONObject e, String type, String key, Object value) {
        try {
            EventHub.emit(e.put("type", type).put(key, value));
        } catch (JSONException ignored) {
            /* never */
        }
    }

    /**
     * Starts / updates / stops mirroring the Connect device this phone controls ({@code null} or
     * {@code active:false} = local again). See {@link RemoteControlPlayer}.
     */
    void cmdSetRemoteControl(@Nullable JSONObject o) {
        RemoteControlPlayer rp = remotePlayer;
        if (rp == null) return;
        if (o == null || !o.optBoolean("active", false)) {
            rp.clearRemote();
            return;
        }
        JSONObject t = o.optJSONObject("track");
        String name = o.optString("deviceName", "");
        rp.setRemote(new RemoteControlPlayer.Remote(
            name.isEmpty() ? "Nocturne" : name,
            o.optDouble("volume", 1.0),
            o.optBoolean("muted", false),
            o.optString("status", "idle"),
            (long) (Math.max(0, o.optDouble("position", 0.0)) * 1000),
            (long) (Math.max(0, o.optDouble("duration", 0.0)) * 1000),
            t == null || t.optString("id", "").isEmpty() ? null : t.optString("id"),
            t == null ? "" : t.optString("title", ""),
            t == null ? "" : t.optString("artist", ""),
            t == null ? "" : t.optString("album", ""),
            t == null ? "" : t.optString("artworkUrl", "")));
    }

    void cmdSetVolume(double volume) {
        ExoPlayer p = player;
        if (p != null) p.setVolume((float) Math.min(1, Math.max(0, volume)));
    }

    void cmdSetRepeat(String mode) {
        ExoPlayer p = player;
        if (p == null) return;
        p.setRepeatMode("one".equals(mode) ? Player.REPEAT_MODE_ONE : "all".equals(mode) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
    }

    void cmdSetShuffleFlag(boolean on) {
        shuffleOn = on;
        refreshButtons();
        persistSession();
    }

    void cmdSetPauseAtEnd(boolean on) {
        ExoPlayer p = player;
        if (p != null) p.setPauseAtEndOfMediaItems(on);
    }

    void cmdStop() {
        ExoPlayer p = player;
        if (p == null) return;
        finishListen();
        p.stop();
        p.clearMediaItems();
        trackJson.clear();
        currentUid = null;
        lastStatus = "";
        SessionStore.clear(this);
        pushWidgets(true);
        emitState();
        refreshButtons();
        try {
            pauseAllPlayersAndStopSelf();
        } catch (Throwable t) {
            AppLog.w(TAG, "stop failed", t);
        }
    }

    void cmdSetLiked(String trackId, boolean liked) {
        if (liked) likedIds.add(trackId);
        else likedIds.remove(trackId);
        refreshButtons();
        scheduleWidgets();
    }

    /** Heart button of a home-screen widget. */
    void cmdWidgetLike() {
        toggleLike();
    }

    /** Widgets were added or removed: a new large widget needs the lyrics, and everything a fresh push. */
    void onWidgetsChanged() {
        if (lrc == null && wantLyrics()) loadLyricsForCurrent();
        scheduleWidgets();
    }

    /** Applies (and persists) the equalizer state; safe at any time, also while audio is playing. */
    void cmdSetEq(EqPrefs.State state) {
        EqPrefs.save(this, state);
        boolean before = eqProcessor.isActive();
        eqProcessor.setState(state);
        // The processor is only in the audio pipeline while it has work to do; a seek to the current position
        // makes ExoPlayer rebuild the pipeline when that changes.
        ExoPlayer p = player;
        if (p != null && p.getMediaItemCount() > 0 && before != eqProcessor.isActive()) p.seekTo(p.getCurrentMediaItemIndex(), Math.max(0, p.getCurrentPosition()));
    }

    void cmdSetLyricsEnabled(boolean enabled) {
        LyricsPref.set(this, enabled);
        lyricsEnabled = enabled;
        lrc = null;
        lrcTrackId = "";
        lastLyricIdx = -2;
        if (!enabled) setLyricLine("");
        loadLyricsForCurrent(); // no-op unless the car or a large widget still wants lyrics
    }

    /** The queue as native sees it (the WebView adopts it when the car started playback). */
    @Nullable
    JSONObject snapshot() {
        ExoPlayer p = player;
        if (p == null || p.getMediaItemCount() == 0) return null;
        try {
            JSONArray items = new JSONArray();
            for (int i = 0; i < p.getMediaItemCount(); i++) {
                MediaItem it = p.getMediaItemAt(i);
                JSONObject o = new JSONObject()
                    .put("uid", it.mediaId)
                    .put("trackId", trackIdOf(it))
                    .put("title", String.valueOf(it.mediaMetadata.title == null ? "" : it.mediaMetadata.title))
                    .put("artist", String.valueOf(it.mediaMetadata.artist == null ? "" : it.mediaMetadata.artist))
                    .put("album", String.valueOf(it.mediaMetadata.albumTitle == null ? "" : it.mediaMetadata.albumTitle))
                    .put("artworkUrl", it.mediaMetadata.artworkUri == null ? "" : it.mediaMetadata.artworkUri.toString())
                    .put("duration", it.mediaMetadata.durationMs == null ? 0 : it.mediaMetadata.durationMs / 1000.0);
                String json = trackJson.get(it.mediaId);
                if (json != null) o.put("track", new JSONObject(json));
                items.put(o);
            }
            return new JSONObject()
                .put("items", items)
                .put("index", p.getCurrentMediaItemIndex())
                .put("position", p.getCurrentPosition() / 1000.0)
                .put("playing", p.getPlayWhenReady())
                .put("repeat", repeatName(p.getRepeatMode()))
                .put("shuffle", shuffleOn)
                .put("contextName", contextName);
        } catch (JSONException e) {
            return null;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Session persistence (survives app close, process death and reboot)
    // ---------------------------------------------------------------------------------------------

    /** Saves the queue, index, position, repeat and shuffle. Cheap enough to call on every event. */
    private void persistSession() {
        ExoPlayer p = player;
        if (p == null || p.getMediaItemCount() == 0) return;
        lastPersistAt = System.currentTimeMillis();
        JSONObject snap = snapshot();
        if (snap != null) SessionStore.save(this, snap);
    }

    private static List<MediaItem> itemsOf(SessionStore.Restored r, Map<String, String> json) {
        List<MediaItem> items = new ArrayList<>();
        for (SessionStore.Entry e : r.entries) {
            items.add(new MediaItem.Builder()
                .setMediaId(e.uid)
                .setUri(trackUri(e.trackId))
                .setMediaMetadata(songMeta(e.title, e.artist, e.album, e.artworkUrl, e.durationMs).build())
                .build());
            if (e.trackJson != null) json.put(e.uid, e.trackJson);
        }
        return items;
    }

    /** Loads the saved session into the (idle) player, paused: the user presses play to continue. */
    private void restoreSession(ExoPlayer p) {
        try {
            SessionStore.Restored r = SessionStore.parse(SessionStore.load(this));
            if (r == null) return;
            Map<String, String> json = new HashMap<>();
            List<MediaItem> items = itemsOf(r, json);
            trackJson.putAll(json);
            contextName = r.contextName;
            shuffleOn = r.shuffle;
            p.setRepeatMode("one".equals(r.repeat) ? Player.REPEAT_MODE_ONE : "all".equals(r.repeat) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
            p.setMediaItems(items, r.index, r.positionMs);
            p.setPlayWhenReady(false);
            MediaItem cur = items.get(r.index);
            currentUid = cur.mediaId;
            long dur = cur.mediaMetadata.durationMs == null ? 0 : cur.mediaMetadata.durationMs;
            listen.start(trackIdOf(cur), dur, System.currentTimeMillis());
            String curJson = json.get(cur.mediaId);
            if (curJson != null && new JSONObject(curJson).optBoolean("liked", false)) likedIds.add(trackIdOf(cur)); // the widget heart may have changed it
        } catch (Throwable t) {
            AppLog.w(TAG, "session restore failed", t);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Player events -> WebView
    // ---------------------------------------------------------------------------------------------

    private final class PlayerEvents implements Player.Listener {
        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_READY) retriedUid = null;
            emitState();
            startTicker();
            scheduleWidgets();
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            emitState();
            startTicker();
            scheduleWidgets();
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            persistSession();
            emitState();
            startTicker();
            scheduleWidgets();
        }

        @Override
        public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
            persistSession();
            if (item == null) {
                finishListen();
                currentUid = null;
                return;
            }
            if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT && item.mediaId.equals(currentUid)) return;
            finishListen();
            currentUid = item.mediaId;
            ExoPlayer p = player;
            long dur = item.mediaMetadata.durationMs == null ? 0 : item.mediaMetadata.durationMs;
            listen.start(trackIdOf(item), dur, System.currentTimeMillis());
            if (p != null) listen.tick(Math.max(0, p.getCurrentPosition()), false);
            lastLyricIdx = -2;
            widgetLine = "";
            loadLyricsForCurrent();
            onTrackStarted(item);
            refreshButtons();
            scheduleWidgets();
            try {
                EventHub.emit(new JSONObject().put("type", "index").put("uid", item.mediaId));
            } catch (JSONException ignored) {
                /* never */
            }
        }

        @Override
        public void onTimelineChanged(@NonNull Timeline timeline, int reason) {
            if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) {
                persistSession();
                scheduleWidgets();
            }
            if (externalQueuePending && reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) {
                externalQueuePending = false;
                main.post(NocturneMediaService.this::emitQueue);
            }
        }

        @Override
        public void onPositionDiscontinuity(@NonNull Player.PositionInfo oldPosition, @NonNull Player.PositionInfo newPosition, int reason) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK) emitPosition();
        }

        @Override
        public void onRepeatModeChanged(int repeatMode) {
            refreshButtons();
            persistSession();
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            ExoPlayer p = player;
            if (p == null) return;
            MediaItem cur = p.getCurrentMediaItem();
            if (cur != null && !cur.mediaId.equals(retriedUid) && api != null && NetMonitor.isOnline(NocturneMediaService.this)) {
                // Signed URLs expire: fetch a fresh one once and resume where we were.
                retriedUid = cur.mediaId;
                api.invalidateStream(trackIdOf(cur));
                long pos = Math.max(0, p.getCurrentPosition());
                p.seekTo(p.getCurrentMediaItemIndex(), pos);
                p.prepare();
                return;
            }
            retriedUid = null;
            Throwable cause = error.getCause();
            AppLog.w("NocturneMedia", "playback error " + error.getErrorCodeName() + " (" + error.errorCode + "): " + error.getMessage()
                + (cause != null ? " / cause: " + cause.getClass().getSimpleName() + ": " + cause.getMessage() : ""));
            errorStreak++;
            try {
                EventHub.emit(new JSONObject().put("type", "error").put("message", getString(R.string.nocturne_media_error) + " (" + error.getErrorCodeName() + ")"));
            } catch (JSONException ignored) {
                /* never */
            }
            if (errorStreak > MAX_AUTO_SKIPS) {
                // Something systematic is wrong: stop instead of racing through the whole queue.
                p.pause();
                return;
            }
            int target = nextPlayableIndex(p);
            if (target != C.INDEX_UNSET) {
                p.seekTo(target, 0);
                p.prepare();
            }
        }
    }

    /**
     * The item to skip to after an error: the next one; while offline, the next one that is fully cached
     * (an uncached song can only fail again), so a playlist plays through what is available.
     */
    private int nextPlayableIndex(ExoPlayer p) {
        int cur = p.getCurrentMediaItemIndex();
        boolean online = NetMonitor.isOnline(this);
        OfflineCache oc = offline;
        for (int i = cur + 1; i < p.getMediaItemCount(); i++) {
            if (online || oc == null || oc.isFullyCached(trackIdOf(p.getMediaItemAt(i)))) return i;
        }
        return C.INDEX_UNSET;
    }

    private void emitState() {
        ExoPlayer p = player;
        if (p == null) return;
        String s;
        int st = p.getPlaybackState();
        if (p.getMediaItemCount() == 0) s = "idle";
        else if (st == Player.STATE_ENDED) s = "ended";
        else if (p.getPlayWhenReady() && st == Player.STATE_BUFFERING) s = "buffering";
        else if (p.isPlaying()) s = "playing";
        else s = "paused";
        if (s.equals(lastStatus)) return;
        lastStatus = s;
        try {
            EventHub.emit(new JSONObject().put("type", "state").put("status", s));
        } catch (JSONException ignored) {
            /* never */
        }
        if ("ended".equals(s)) finishListen();
    }

    private void emitPosition() {
        ExoPlayer p = player;
        if (p == null || p.getMediaItemCount() == 0) return;
        long d = p.getDuration();
        if (d == C.TIME_UNSET || d <= 0) {
            MediaItem cur = p.getCurrentMediaItem();
            d = cur == null || cur.mediaMetadata.durationMs == null ? 0 : cur.mediaMetadata.durationMs;
        }
        try {
            EventHub.emit(new JSONObject().put("type", "position").put("position", Math.max(0, p.getCurrentPosition()) / 1000.0).put("duration", d / 1000.0));
        } catch (JSONException ignored) {
            /* never */
        }
    }

    private void emitQueue() {
        JSONObject snap = snapshot();
        if (snap == null) return;
        try {
            EventHub.emit(new JSONObject().put("type", "queue").put("snapshot", snap));
        } catch (JSONException ignored) {
            /* never */
        }
    }

    private void startTicker() {
        main.removeCallbacks(ticker);
        ExoPlayer p = player;
        if (p != null && p.getPlayWhenReady() && p.getMediaItemCount() > 0 && p.getPlaybackState() != Player.STATE_ENDED) {
            main.postDelayed(ticker, TICK_MS);
        }
    }

    private void tick() {
        ExoPlayer p = player;
        if (p == null || p.getMediaItemCount() == 0) return;
        long pos = Math.max(0, p.getCurrentPosition());
        long d = p.getDuration();
        if (d != C.TIME_UNSET && d > 0) listen.setDuration(d);
        listen.tick(pos, p.isPlaying());
        if (p.isPlaying() && pos > 3000) errorStreak = 0;
        emitPosition();
        if (System.currentTimeMillis() - lastPersistAt >= PERSIST_MS) persistSession();
        boolean widgetLyrics = widgets != null && widgets.hasLarge();
        int widgetIdx = -2;
        if ((lyricsEnabled || widgetLyrics) && lrc != null && lrcTrackId.equals(currentTrackId())) {
            int idx = lrc.lineAt(pos);
            long now = System.currentTimeMillis();
            if (widgetLyrics) {
                widgetIdx = idx;
                widgetLine = idx < 0 ? "" : lrc.line(idx);
            }
            if (lyricsEnabled && idx != lastLyricIdx && now - lastLyricAt >= 900) {
                lastLyricIdx = idx;
                lastLyricAt = now;
                setLyricLine(idx < 0 ? "" : lrc.line(idx));
            }
        }
        if (widgets != null && widgetLyrics) widgets.pushTick(widgetState(false), widgetIdx);
    }

    private void finishListen() {
        ListenTracker.Listen l = listen.finish();
        if (l != null && reporter != null) reporter.report(l);
    }

    // ---------------------------------------------------------------------------------------------
    // Lyrics line (optional)
    // ---------------------------------------------------------------------------------------------

    @Nullable
    private String currentTrackId() {
        ExoPlayer p = player;
        MediaItem cur = p == null ? null : p.getCurrentMediaItem();
        return cur == null ? null : trackIdOf(cur);
    }

    private void loadLyricsForCurrent() {
        lrc = null;
        lrcTrackId = "";
        final String id = currentTrackId();
        final NocturneApi a = api;
        if (!wantLyrics() || id == null || a == null || !a.hasSession()) return;
        io.execute(() -> {
            try {
                JSONObject o = OfflineMeta.lyrics(this, id);
                if (o == null) o = a.getJson("/v1/tracks/" + NocturneApi.pathId(id) + "/lyrics");
                String synced = o.isNull("synced") ? "" : o.optString("synced", "");
                if (synced.isEmpty()) return;
                final LrcParser parsed = LrcParser.parse(synced, o.optLong("offsetMs", 0));
                main.post(() -> {
                    if (wantLyrics() && id.equals(currentTrackId()) && !parsed.isEmpty()) {
                        lrc = parsed;
                        lrcTrackId = id;
                        lastLyricIdx = -2;
                        scheduleWidgets();
                    }
                });
            } catch (Throwable ignored) {
                /* no lyrics: the subtitle stays empty */
            }
        });
    }

    /** The car's lyric line or a large home-screen widget wants synced lyrics for the current song. */
    private boolean wantLyrics() {
        return lyricsEnabled || (widgets != null && widgets.hasLarge());
    }

    // ---------------------------------------------------------------------------------------------
    // Home-screen widgets
    // ---------------------------------------------------------------------------------------------

    /** Coalesces bursts of player events into one widget update. */
    private void scheduleWidgets() {
        main.removeCallbacks(widgetPush);
        main.postDelayed(widgetPush, 150);
    }

    private void pushWidgets(boolean paused) {
        WidgetUpdater w = widgets;
        if (w == null) return;
        try {
            w.pushFull(widgetState(paused));
        } catch (Throwable t) {
            AppLog.w(TAG, "widget push failed", t);
        }
    }

    /** The now-playing state for the widgets (main thread). */
    private WidgetState widgetState(boolean forcePaused) {
        ExoPlayer p = player;
        if (p == null || p.getMediaItemCount() == 0) return WidgetState.EMPTY;
        MediaItem cur = p.getCurrentMediaItem();
        if (cur == null) return WidgetState.EMPTY;
        int st = p.getPlaybackState();
        boolean playing = !forcePaused && p.getPlayWhenReady() && (st == Player.STATE_READY || st == Player.STATE_BUFFERING);
        long dur = p.getDuration();
        if (dur == C.TIME_UNSET || dur <= 0) dur = cur.mediaMetadata.durationMs == null ? 0 : cur.mediaMetadata.durationMs;
        String id = trackIdOf(cur);
        WidgetState.Builder b = new WidgetState.Builder()
            .queue(true)
            .track(
                id,
                cur.mediaMetadata.title == null ? "" : cur.mediaMetadata.title.toString(),
                cur.mediaMetadata.artist == null ? "" : cur.mediaMetadata.artist.toString(),
                cur.mediaMetadata.artworkUri == null ? "" : cur.mediaMetadata.artworkUri.toString())
            .playing(playing)
            .liked(likedIds.contains(id))
            .position(Math.max(0, p.getCurrentPosition()), dur)
            .lyric(lrc != null && lrcTrackId.equals(id) ? widgetLine : "");
        int at = p.getCurrentMediaItemIndex();
        for (int i = at + 1; i < p.getMediaItemCount() && i <= at + 3; i++) {
            MediaItem it = p.getMediaItemAt(i);
            b.next(it.mediaMetadata.title == null ? "" : it.mediaMetadata.title.toString(), it.mediaMetadata.artist == null ? "" : it.mediaMetadata.artist.toString());
        }
        return b.build();
    }

    /** Puts the current lyric line in the session metadata subtitle (not an official Android Auto feature). */
    private void setLyricLine(String line) {
        ExoPlayer p = player;
        if (p == null) return;
        MediaItem cur = p.getCurrentMediaItem();
        if (cur == null) return;
        CharSequence now = cur.mediaMetadata.subtitle;
        String want = line == null || line.isEmpty() ? null : line;
        if ((now == null ? null : now.toString()) == null ? want == null : now.toString().equals(want)) return;
        MediaMetadata md = cur.mediaMetadata.buildUpon().setSubtitle(want).setDescription(want).build();
        p.replaceMediaItem(p.getCurrentMediaItemIndex(), cur.buildUpon().setMediaMetadata(md).build());
    }

    // ---------------------------------------------------------------------------------------------
    // Queue helpers
    // ---------------------------------------------------------------------------------------------

    private static int indexOfId(List<MediaItem> items, String id) {
        for (int i = 0; i < items.size(); i++) if (items.get(i).mediaId.equals(id)) return i;
        return -1;
    }

    private static int indexInPlayer(ExoPlayer p, String id) {
        for (int i = 0; i < p.getMediaItemCount(); i++) if (p.getMediaItemAt(i).mediaId.equals(id)) return i;
        return -1;
    }

    private static boolean sameIds(ExoPlayer p, List<MediaItem> items) {
        if (p.getMediaItemCount() != items.size()) return false;
        for (int i = 0; i < items.size(); i++) if (!p.getMediaItemAt(i).mediaId.equals(items.get(i).mediaId)) return false;
        return true;
    }

    /** Replaces everything around the current item without interrupting it. */
    private static void alignAround(ExoPlayer p, List<MediaItem> items, int curInNew) {
        int pc = p.getCurrentMediaItemIndex();
        int n = p.getMediaItemCount();
        if (pc + 1 < n) p.removeMediaItems(pc + 1, n);
        List<MediaItem> after = items.subList(curInNew + 1, items.size());
        if (!after.isEmpty()) p.addMediaItems(new ArrayList<>(after));
        if (pc > 0) p.removeMediaItems(0, pc);
        List<MediaItem> before = items.subList(0, curInNew);
        if (!before.isEmpty()) p.addMediaItems(0, new ArrayList<>(before));
    }

    static String trackIdOf(MediaItem item) {
        MediaItem.LocalConfiguration lc = item.localConfiguration;
        if (lc == null) return MediaIds.parse(item.mediaId).id;
        String seg = lc.uri.getLastPathSegment();
        return seg == null ? "" : seg;
    }

    static Uri trackUri(String trackId) {
        return new Uri.Builder().scheme("nocturne").authority("track").appendPath(trackId).build();
    }

    private String newUid() {
        return "n" + Long.toString(System.currentTimeMillis(), 36) + Long.toString(uidCounter.incrementAndGet(), 36);
    }

    private static MediaMetadata.Builder songMeta(String title, String artist, String album, String art, long durationMs) {
        MediaMetadata.Builder b = new MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(artist)
            .setAlbumTitle(album)
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC);
        if (durationMs > 0) b.setDurationMs(durationMs);
        if (art != null && !art.isEmpty()) b.setArtworkUri(Uri.parse(art));
        return b;
    }

    /** A queue entry from the WebView. */
    static MediaItem itemFromJs(JSONObject o) {
        String trackId = o.optString("trackId", "");
        return new MediaItem.Builder()
            .setMediaId(o.optString("uid", ""))
            .setUri(trackUri(trackId))
            .setMediaMetadata(
                songMeta(o.optString("title", ""), o.optString("artist", ""), o.optString("album", ""), o.optString("artworkUrl", ""), (long) (o.optDouble("duration", 0) * 1000)).build())
            .build();
    }

    private MediaItem queueItem(TrackInfo t) {
        return new MediaItem.Builder()
            .setMediaId(newUid())
            .setUri(trackUri(t.id))
            .setMediaMetadata(offlineArt(songMeta(t.title, t.artist, t.album, t.artUrl, t.durationMs), t.id).build())
            .build();
    }

    /** While offline the signed cover URL cannot load: embed the stored 512 px cover so the notification still has art. */
    private MediaMetadata.Builder offlineArt(MediaMetadata.Builder b, String trackId) {
        if (trackId.isEmpty() || NetMonitor.isOnline(this)) return b;
        java.io.File f = OfflineMeta.art(this, trackId);
        if (f == null || f.length() > 400 * 1024) return b;
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            b.setArtworkData(out.toByteArray(), MediaMetadata.PICTURE_TYPE_FRONT_COVER);
        } catch (java.io.IOException ignored) {
            /* no cover offline */
        }
        return b;
    }

    private List<MediaItem> withOfflineArt(List<MediaItem> items) {
        if (NetMonitor.isOnline(this)) return items;
        List<MediaItem> out = new ArrayList<>(items.size());
        for (MediaItem it : items) {
            out.add(it.buildUpon().setMediaMetadata(offlineArt(it.mediaMetadata.buildUpon(), trackIdOf(it)).build()).build());
        }
        return out;
    }

    private final Runnable prefetchTask = this::runPrefetch;

    /** A track started playing: it becomes the most recent in the cache, its extras are stored, the next one is prefetched. */
    private void onTrackStarted(MediaItem item) {
        final String id = trackIdOf(item);
        OfflineCache oc = offline;
        final NocturneApi a = api;
        if (oc == null || id.isEmpty()) return;
        oc.evictor().touch(id);
        if (a != null && a.hasSession() && !OfflineMeta.has(this, id) && NetMonitor.isOnline(this)) {
            io.execute(() -> OfflineMeta.fetch(this, a, id));
        }
        cancelPrefetch();
        main.postDelayed(prefetchTask, 8000);
    }

    private void cancelPrefetch() {
        main.removeCallbacks(prefetchTask);
        androidx.media3.datasource.cache.CacheWriter w = prefetch;
        prefetch = null;
        if (w != null) w.cancel();
    }

    /** Warms the cache with the next queued track (Wi-Fi only unless the user allowed mobile data). */
    private void runPrefetch() {
        final ExoPlayer p = player;
        final OfflineCache oc = offline;
        if (p == null || oc == null || p.getMediaItemCount() == 0) return;
        int ni = p.getNextMediaItemIndex();
        if (ni == C.INDEX_UNSET) return;
        final String id = trackIdOf(p.getMediaItemAt(ni));
        if (id.isEmpty() || oc.isFullyCached(id) || !NetMonitor.isOnline(this)) return;
        if (OfflinePrefs.prefetchWifiOnly(this) && !NetMonitor.isUnmetered(this)) return;
        io.execute(() -> {
            try {
                androidx.media3.datasource.DataSpec spec = new androidx.media3.datasource.DataSpec.Builder().setUri(trackUri(id)).setKey(id).build();
                androidx.media3.datasource.cache.CacheWriter w =
                    new androidx.media3.datasource.cache.CacheWriter(oc.dataSources().createDataSourceForDownloading(), spec, null, null);
                prefetch = w;
                w.cache();
            } catch (Throwable t) {
                AppLog.w(TAG, "prefetch skipped: " + t.getClass().getSimpleName());
            } finally {
                prefetch = null;
            }
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Session buttons
    // ---------------------------------------------------------------------------------------------

    private boolean currentLiked() {
        String id = currentTrackId();
        return id != null && likedIds.contains(id);
    }

    private String buttonsKey() {
        ExoPlayer p = player;
        return (shuffleOn ? "S" : "s") + (p == null ? 0 : p.getRepeatMode());
    }

    private void refreshButtons() {
        MediaLibrarySession s = session;
        String key = buttonsKey();
        if (s == null || key.equals(buttonsKey)) return;
        buttonsKey = key;
        try {
            s.setMediaButtonPreferences(buttons());
        } catch (Throwable t) {
            AppLog.e(TAG, "setMediaButtonPreferences failed", t);
        }
    }

    private static String repeatName(int mode) {
        return mode == Player.REPEAT_MODE_ONE ? "one" : mode == Player.REPEAT_MODE_ALL ? "all" : "off";
    }

    /** Shuffle and Repeat, so Previous / Play-Pause / Next always keep their slots. */
    private ImmutableList<CommandButton> buttons() {
        ExoPlayer p = player;
        boolean shuffle = shuffleOn;
        int mode = p == null ? Player.REPEAT_MODE_OFF : p.getRepeatMode();
        CommandButton shuf = new CommandButton.Builder(shuffle ? CommandButton.ICON_SHUFFLE_ON : CommandButton.ICON_SHUFFLE_OFF)
            .setCustomIconResId(shuffle ? R.drawable.ic_media_shuffle_on : R.drawable.ic_media_shuffle_off)
            .setDisplayName(getString(shuffle ? R.string.nocturne_media_shuffle_on : R.string.nocturne_media_shuffle_off))
            .setSessionCommand(SHUFFLE)
            .build();
        int repeatIcon;
        int repeatRes;
        int repeatLabel;
        if (mode == Player.REPEAT_MODE_ALL) {
            repeatIcon = CommandButton.ICON_REPEAT_ALL;
            repeatRes = R.drawable.ic_media_repeat_all;
            repeatLabel = R.string.nocturne_media_repeat_all;
        } else if (mode == Player.REPEAT_MODE_ONE) {
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
            .setDisplayName(getString(repeatLabel))
            .setSessionCommand(REPEAT)
            .build();
        // The heart is deliberately not a button: it took the slot of "Next" on Samsung's media panel.
        // (The LIKE command stays registered for controllers that send it, e.g. Android Auto custom UIs.)
        return ImmutableList.of(shuf, repeat);
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
            AppLog.w(TAG, "session activity intent unavailable", t);
            return null;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Browse tree
    // ---------------------------------------------------------------------------------------------

    private MediaItem folder(String id, String title) {
        return new MediaItem.Builder()
            .setMediaId(id)
            .setMediaMetadata(
                new MediaMetadata.Builder().setTitle(title).setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build())
            .build();
    }

    private ImmutableList<MediaItem> tabs() {
        return ImmutableList.of(
            folder(MediaIds.MIXES, getString(R.string.nocturne_auto_mixes)),
            folder(MediaIds.PLAYLISTS, getString(R.string.nocturne_auto_playlists)),
            folder(MediaIds.LIKED, getString(R.string.nocturne_auto_liked)),
            folder(MediaIds.RECENT, getString(R.string.nocturne_auto_recent)),
            folder(MediaIds.ALBUMS, getString(R.string.nocturne_auto_albums)),
            folder(MediaIds.ARTISTS, getString(R.string.nocturne_auto_artists)),
            folder(MediaIds.DOWNLOADS, getString(R.string.nocturne_auto_downloads)));
    }

    private MediaItem nodeItem(Library.Node n) {
        MediaMetadata.Builder md;
        MediaItem.Builder b = new MediaItem.Builder().setMediaId(n.id);
        if (n.track != null) {
            md = offlineArt(songMeta(n.track.title, n.track.artist, n.track.album, n.track.artUrl, n.track.durationMs), n.track.id);
            b.setUri(trackUri(n.track.id));
            if (n.track.liked) likedIds.add(n.track.id);
        } else {
            md = new MediaMetadata.Builder()
                .setTitle(n.title)
                .setSubtitle(n.subtitle)
                .setIsBrowsable(n.browsable)
                .setIsPlayable(n.playable)
                .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED);
            if (!n.artUrl.isEmpty()) md.setArtworkUri(Uri.parse(n.artUrl));
        }
        return b.setMediaMetadata(md.build()).build();
    }

    private ImmutableList<MediaItem> nodeItems(List<Library.Node> nodes) {
        ImmutableList.Builder<MediaItem> out = ImmutableList.builder();
        for (Library.Node n : nodes) out.add(nodeItem(n));
        return out.build();
    }

    private boolean signedIn() {
        return api != null && api.hasSession();
    }

    private static LibraryResult<ImmutableList<MediaItem>> authError() {
        return LibraryResult.ofError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED);
    }

    private static <T> LibraryResult<T> failure(Throwable t) {
        AppLog.w(TAG, "library request failed: " + t.getClass().getSimpleName());
        if (t instanceof NocturneApi.AuthException) return LibraryResult.ofError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED);
        return LibraryResult.ofError(SessionError.ERROR_UNKNOWN);
    }

    /** Turns a browse/voice request into a queue (the whole container the song belongs to). */
    private MediaSession.MediaItemsWithStartPosition resolve(List<MediaItem> req, int startIndex, long startPositionMs) throws IOException {
        Library lib = library;
        if (lib == null || !signedIn()) throw new NocturneApi.AuthException("signed out");
        List<MediaItem> out = new ArrayList<>();
        Map<String, String> json = new HashMap<>();
        String name = "";
        int start = 0;

        MediaItem first = req.isEmpty() ? null : req.get(0);
        MediaIds.Parsed p0 = first == null ? null : MediaIds.parse(first.mediaId);
        String query = first == null ? null : first.requestMetadata.searchQuery;
        boolean voice = first != null && query != null && (first.mediaId.isEmpty() || p0.kind.isEmpty());
        boolean emptyRequest = req.isEmpty();

        if (voice || emptyRequest) {
            String ctx = voice && !query.trim().isEmpty() ? lib.resolveVoiceQuery(query) : MediaIds.LIKED;
            Library.TrackList tl = lib.tracksOf(ctx);
            if (tl.tracks.isEmpty() && !ctx.equals(MediaIds.RECENT) && query != null && query.trim().isEmpty()) tl = lib.tracksOf(MediaIds.RECENT);
            if (tl.tracks.isEmpty()) throw new IOException("nothing to play");
            name = tl.name;
            for (TrackInfo t : tl.tracks) {
                MediaItem it = queueItem(t);
                out.add(it);
                json.put(it.mediaId, t.json);
            }
        } else if (req.size() == 1) {
            MediaItem it = req.get(0);
            MediaIds.Parsed p = MediaIds.parse(it.mediaId);
            if (MediaIds.KIND_TRACK.equals(p.kind)) {
                Library.TrackList tl = p.ctx.isEmpty() ? null : lib.tracksOf(p.ctx);
                int at = -1;
                if (tl != null) {
                    for (int i = 0; i < tl.tracks.size(); i++) {
                        if (tl.tracks.get(i).id.equals(p.id)) {
                            at = i;
                            break;
                        }
                    }
                }
                if (tl != null && at >= 0) {
                    name = tl.name;
                    start = at;
                    for (TrackInfo t : tl.tracks) {
                        MediaItem q = queueItem(t);
                        out.add(q);
                        json.put(q.mediaId, t.json);
                    }
                } else {
                    TrackInfo t = lib.track(p.id);
                    if (t == null) throw new IOException("unknown track");
                    MediaItem q = queueItem(t);
                    out.add(q);
                    json.put(q.mediaId, t.json);
                }
            } else if (isContainer(p.kind)) {
                Library.TrackList tl = lib.tracksOf(it.mediaId);
                if (tl.tracks.isEmpty()) throw new IOException("empty container");
                name = tl.name;
                for (TrackInfo t : tl.tracks) {
                    MediaItem q = queueItem(t);
                    out.add(q);
                    json.put(q.mediaId, t.json);
                }
            } else {
                out.add(it); // already a playable queue item
            }
        } else {
            for (MediaItem it : req) {
                MediaIds.Parsed p = MediaIds.parse(it.mediaId);
                if (MediaIds.KIND_TRACK.equals(p.kind)) {
                    TrackInfo t = lib.track(p.id);
                    if (t == null) continue;
                    MediaItem q = queueItem(t);
                    out.add(q);
                    json.put(q.mediaId, t.json);
                } else if (it.localConfiguration != null) {
                    out.add(it);
                }
            }
            start = Math.min(Math.max(0, startIndex), Math.max(0, out.size() - 1));
        }
        if (out.isEmpty()) throw new IOException("nothing to play");
        final String ctxName = name;
        main.post(() -> {
            trackJson.clear();
            trackJson.putAll(json);
            contextName = ctxName;
            externalQueuePending = true;
        });
        return new MediaSession.MediaItemsWithStartPosition(out, start, C.TIME_UNSET);
    }

    private static boolean isContainer(String kind) {
        return MediaIds.KIND_MIX.equals(kind)
            || MediaIds.KIND_PLAYLIST.equals(kind)
            || MediaIds.KIND_ALBUM.equals(kind)
            || MediaIds.KIND_ARTIST.equals(kind)
            || MediaIds.LIKED.equals(kind)
            || MediaIds.RECENT.equals(kind);
    }

    private final class Callback implements MediaLibrarySession.Callback {
        @NonNull
        @Override
        public MediaSession.ConnectionResult onConnect(@NonNull MediaSession mediaSession, @NonNull MediaSession.ControllerInfo controller) {
            // Media3's defaults plus our three buttons, for every controller: OEM surfaces (Samsung quick
            // panel / Now Bar) and Android Auto must be able to use them.
            MediaSession.ConnectionResult defaults =
                new MediaSession.ConnectionResult.AcceptedResultBuilder(mediaSession, controller).build();
            SessionCommands commands = defaults.availableSessionCommands.buildUpon().add(LIKE).add(SHUFFLE).add(REPEAT).build();
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(mediaSession, controller)
                .setAvailableSessionCommands(commands)
                // "Next" must be offered even at the end of the queue (autoplay / repeat decide what it does).
                .setAvailablePlayerCommands(defaults.availablePlayerCommands.buildUpon()
                    .add(Player.COMMAND_SEEK_TO_NEXT)
                    .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                    .build())
                .setMediaButtonPreferences(buttons())
                .build();
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(
            @NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @Nullable LibraryParams params) {
            MediaItem root = new MediaItem.Builder()
                .setMediaId(MediaIds.ROOT)
                .setMediaMetadata(new MediaMetadata.Builder().setTitle("Nocturne").setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build())
                .build();
            return Futures.immediateFuture(LibraryResult.ofItem(root, params));
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetItem(
            @NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @NonNull String mediaId) {
            for (MediaItem t : tabs()) if (t.mediaId.equals(mediaId)) return Futures.immediateFuture(LibraryResult.ofItem(t, null));
            if (MediaIds.ROOT.equals(mediaId)) {
                return Futures.immediateFuture(LibraryResult.ofItem(folder(MediaIds.ROOT, "Nocturne"), null));
            }
            return io.submit(() -> {
                try {
                    MediaIds.Parsed p = MediaIds.parse(mediaId);
                    Library lib = library;
                    if (lib == null || !signedIn()) return LibraryResult.<MediaItem>ofError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED);
                    if (MediaIds.KIND_TRACK.equals(p.kind)) {
                        TrackInfo t = lib.track(p.id);
                        if (t == null) return LibraryResult.<MediaItem>ofError(SessionError.ERROR_BAD_VALUE);
                        return LibraryResult.ofItem(nodeItem(new Library.Node(mediaId, t.title, t.artist, t.artUrl, false, true, t)), null);
                    }
                    return LibraryResult.<MediaItem>ofError(SessionError.ERROR_NOT_SUPPORTED);
                } catch (Throwable t) {
                    return failure(t);
                }
            });
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(
            @NonNull MediaLibrarySession s,
            @NonNull MediaSession.ControllerInfo browser,
            @NonNull String parentId,
            int page,
            int pageSize,
            @Nullable LibraryParams params) {
            if (!signedIn()) return Futures.immediateFuture(authError());
            if (MediaIds.ROOT.equals(parentId)) {
                int[] sl = MediaIds.slice(7, MediaIds.window(page, pageSize));
                return Futures.immediateFuture(LibraryResult.ofItemList(tabs().subList(sl[0], sl[1]), params));
            }
            return io.submit(() -> {
                try {
                    Library lib = library;
                    if (lib == null) return LibraryResult.<ImmutableList<MediaItem>>ofError(SessionError.ERROR_UNKNOWN);
                    return LibraryResult.ofItemList(nodeItems(lib.children(parentId, page, pageSize)), params);
                } catch (Throwable t) {
                    return failure(t);
                }
            });
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<Void>> onSearch(
            @NonNull MediaLibrarySession s, @NonNull MediaSession.ControllerInfo browser, @NonNull String query, @Nullable LibraryParams params) {
            if (!signedIn()) return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED));
            io.execute(() -> {
                try {
                    Library lib = library;
                    if (lib == null) return;
                    List<Library.Node> nodes = lib.search(query, 50);
                    searchResults.put(query, nodes);
                    s.notifySearchResultChanged(browser, query, nodes.size(), params);
                } catch (Throwable t) {
                    AppLog.w(TAG, "search failed: " + t.getClass().getSimpleName());
                }
            });
            return Futures.immediateFuture(LibraryResult.ofVoid());
        }

        @NonNull
        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetSearchResult(
            @NonNull MediaLibrarySession s,
            @NonNull MediaSession.ControllerInfo browser,
            @NonNull String query,
            int page,
            int pageSize,
            @Nullable LibraryParams params) {
            return io.submit(() -> {
                try {
                    List<Library.Node> nodes = searchResults.get(query);
                    if (nodes == null && library != null) nodes = library.search(query, 50);
                    if (nodes == null) nodes = new ArrayList<>();
                    int[] sl = MediaIds.slice(nodes.size(), MediaIds.window(page, pageSize));
                    return LibraryResult.ofItemList(nodeItems(nodes.subList(sl[0], sl[1])), params);
                } catch (Throwable t) {
                    return failure(t);
                }
            });
        }

        @NonNull
        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controller,
            @NonNull List<MediaItem> mediaItems,
            int startIndex,
            long startPositionMs) {
            return io.submit(() -> resolve(mediaItems, startIndex, startPositionMs));
        }

        @NonNull
        @Override
        public ListenableFuture<List<MediaItem>> onAddMediaItems(
            @NonNull MediaSession mediaSession, @NonNull MediaSession.ControllerInfo controller, @NonNull List<MediaItem> mediaItems) {
            return io.submit(() -> resolve(mediaItems, 0, C.TIME_UNSET).mediaItems);
        }

        /** System "resume" (media resumption card, Bluetooth / Android Auto play after a reboot): the saved queue. */
        @NonNull
        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(
            @NonNull MediaSession mediaSession, @NonNull MediaSession.ControllerInfo controller, boolean isForPlayback) {
            SessionStore.Restored r = SessionStore.parse(SessionStore.load(NocturneMediaService.this));
            if (r == null) return Futures.immediateFailedFuture(new UnsupportedOperationException("nothing to resume"));
            Map<String, String> json = new HashMap<>();
            List<MediaItem> items = itemsOf(r, json);
            main.post(() -> {
                trackJson.putAll(json);
                contextName = r.contextName;
                shuffleOn = r.shuffle;
            });
            return Futures.immediateFuture(new MediaSession.MediaItemsWithStartPosition(items, r.index, r.positionMs));
        }

        @NonNull
        @Override
        public ListenableFuture<SessionResult> onCustomCommand(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controller,
            @NonNull SessionCommand customCommand,
            @NonNull Bundle args) {
            String action = customCommand.customAction;
            ExoPlayer p = player;
            if (p == null) return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            if (ACTION_LIKE.equals(action)) {
                toggleLike();
            } else if (ACTION_SHUFFLE.equals(action)) {
                if (EventHub.hasSink()) {
                    emitCommand("shuffle");
                } else {
                    // No WebView to own the order: let ExoPlayer shuffle what is left.
                    shuffleOn = !shuffleOn;
                    p.setShuffleModeEnabled(shuffleOn);
                    refreshButtons();
                }
            } else if (ACTION_REPEAT.equals(action)) {
                if (EventHub.hasSink()) {
                    emitCommand("repeat");
                } else {
                    int m = p.getRepeatMode();
                    p.setRepeatMode(m == Player.REPEAT_MODE_OFF ? Player.REPEAT_MODE_ALL : m == Player.REPEAT_MODE_ALL ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
                }
            } else {
                return Futures.immediateFuture(new SessionResult(SessionError.ERROR_NOT_SUPPORTED));
            }
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
        }
    }

    private void emitCommand(String kind) {
        try {
            EventHub.emit(new JSONObject().put("type", "command").put("kind", kind));
        } catch (JSONException ignored) {
            /* never */
        }
    }

    /** Heart button: optimistic flip, then the server call; the WebView (if alive) mirrors it. */
    private void toggleLike() {
        final String id = currentTrackId();
        final NocturneApi a = api;
        if (id == null || id.isEmpty() || a == null) return;
        final boolean now = !likedIds.contains(id);
        cmdSetLiked(id, now);
        try {
            EventHub.emit(new JSONObject().put("type", "liked").put("trackId", id).put("liked", now));
        } catch (JSONException ignored) {
            /* never */
        }
        io.execute(() -> {
            try {
                a.request(now ? "PUT" : "DELETE", "/v1/library/tracks/" + NocturneApi.pathId(id), null);
            } catch (Throwable t) {
                AppLog.w(TAG, "like failed: " + t.getClass().getSimpleName());
                main.post(() -> {
                    cmdSetLiked(id, !now);
                    try {
                        EventHub.emit(new JSONObject().put("type", "liked").put("trackId", id).put("liked", !now));
                    } catch (JSONException ignored) {
                        /* never */
                    }
                });
            }
        });
    }
}
