package es.alexcloudweb.nocturne.media;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
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
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.ExoPlayer;
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
    @Nullable private NocturneApi api;
    @Nullable private Library library;
    @Nullable private PlayReporter reporter;

    private String lastStatus = "";
    private String buttonsKey = "";
    @Nullable private String currentUid;
    @Nullable private String retriedUid;
    private boolean externalQueuePending;
    private boolean shuffleOn;
    private String contextName = "";
    private final java.util.concurrent.atomic.AtomicLong uidCounter = new java.util.concurrent.atomic.AtomicLong();

    // Lyrics line in the car (off by default).
    private boolean lyricsEnabled;
    @Nullable private LrcParser lrc;
    private String lrcTrackId = "";
    private int lastLyricIdx = -2;
    private long lastLyricAt;

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
            final NocturneApi apiRef = api;

            ResolvingDataSource.Factory dataSources = new ResolvingDataSource.Factory(
                new DefaultDataSource.Factory(this, new DefaultHttpDataSource.Factory().setUserAgent("Nocturne-Android").setAllowCrossProtocolRedirects(true)),
                dataSpec -> {
                    Uri u = dataSpec.uri;
                    if ("nocturne".equals(u.getScheme()) && "track".equals(u.getHost())) {
                        String id = u.getLastPathSegment();
                        if (id == null) throw new IOException("bad track uri");
                        return dataSpec.withUri(Uri.parse(apiRef.streamUrl(id)));
                    }
                    return dataSpec;
                }
            );
            ExoPlayer p = new ExoPlayer.Builder(this)
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
            MediaLibrarySession.Builder builder = new MediaLibrarySession.Builder(this, p, new Callback())
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
                    Log.w(TAG, "foreground service start not allowed; media notification deferred");
                }
            });
            buttonsKey = buttonsKey();
            lyricsEnabled = LyricsPref.get(this);
            reporter.flush();
            EventHub.attach(this);
        } catch (Throwable t) {
            Log.e(TAG, "media service setup failed", t);
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
                Log.w(TAG, "stop after task removal failed", t);
                stopSelf();
            }
        }
    }

    @Override
    public void onDestroy() {
        persistSession();
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
            Log.e(TAG, "release failed", t);
        }
        io.shutdown();
        super.onDestroy();
    }

    // ---------------------------------------------------------------------------------------------
    // Commands from the WebView (main thread)
    // ---------------------------------------------------------------------------------------------

    /** Aligns the ExoPlayer playlist with the WebView's queue; keeps the current item playing when it is still there. */
    void cmdSetQueue(List<MediaItem> items, int index, @Nullable Boolean play, long startMs, boolean reset) {
        ExoPlayer p = player;
        if (p == null || items.isEmpty()) return;
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
        emitState();
        refreshButtons();
        try {
            pauseAllPlayersAndStopSelf();
        } catch (Throwable t) {
            Log.w(TAG, "stop failed", t);
        }
    }

    void cmdSetLiked(String trackId, boolean liked) {
        if (liked) likedIds.add(trackId);
        else likedIds.remove(trackId);
        refreshButtons();
    }

    void cmdSetLyricsEnabled(boolean enabled) {
        LyricsPref.set(this, enabled);
        lyricsEnabled = enabled;
        lrc = null;
        lrcTrackId = "";
        lastLyricIdx = -2;
        if (!enabled) setLyricLine("");
        else loadLyricsForCurrent();
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
        } catch (Throwable t) {
            Log.w(TAG, "session restore failed", t);
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
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            emitState();
            startTicker();
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            persistSession();
            emitState();
            startTicker();
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
            loadLyricsForCurrent();
            refreshButtons();
            try {
                EventHub.emit(new JSONObject().put("type", "index").put("uid", item.mediaId));
            } catch (JSONException ignored) {
                /* never */
            }
        }

        @Override
        public void onTimelineChanged(@NonNull Timeline timeline, int reason) {
            if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) persistSession();
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
            if (cur != null && !cur.mediaId.equals(retriedUid) && api != null) {
                // Signed URLs expire: fetch a fresh one once and resume where we were.
                retriedUid = cur.mediaId;
                api.invalidateStream(trackIdOf(cur));
                long pos = Math.max(0, p.getCurrentPosition());
                p.seekTo(p.getCurrentMediaItemIndex(), pos);
                p.prepare();
                return;
            }
            retriedUid = null;
            Log.w(TAG, "playback error " + error.getErrorCodeName());
            try {
                EventHub.emit(new JSONObject().put("type", "error").put("message", getString(R.string.nocturne_media_error)));
            } catch (JSONException ignored) {
                /* never */
            }
            if (p.hasNextMediaItem()) {
                p.seekToNextMediaItem();
                p.prepare();
            }
        }
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
        emitPosition();
        if (System.currentTimeMillis() - lastPersistAt >= PERSIST_MS) persistSession();
        if (lyricsEnabled && lrc != null && lrcTrackId.equals(currentTrackId())) {
            int idx = lrc.lineAt(pos);
            long now = System.currentTimeMillis();
            if (idx != lastLyricIdx && now - lastLyricAt >= 900) {
                lastLyricIdx = idx;
                lastLyricAt = now;
                setLyricLine(idx < 0 ? "" : lrc.line(idx));
            }
        }
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
        if (!lyricsEnabled || id == null || a == null || !a.hasSession()) return;
        io.execute(() -> {
            try {
                JSONObject o = a.getJson("/v1/tracks/" + NocturneApi.pathId(id) + "/lyrics");
                String synced = o.isNull("synced") ? "" : o.optString("synced", "");
                if (synced.isEmpty()) return;
                final LrcParser parsed = LrcParser.parse(synced, o.optLong("offsetMs", 0));
                main.post(() -> {
                    if (lyricsEnabled && id.equals(currentTrackId()) && !parsed.isEmpty()) {
                        lrc = parsed;
                        lrcTrackId = id;
                        lastLyricIdx = -2;
                    }
                });
            } catch (Throwable ignored) {
                /* no lyrics: the subtitle stays empty */
            }
        });
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
            .setMediaMetadata(songMeta(t.title, t.artist, t.album, t.artUrl, t.durationMs).build())
            .build();
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
        return (currentLiked() ? "L" : "l") + (shuffleOn ? "S" : "s") + (p == null ? 0 : p.getRepeatMode());
    }

    private void refreshButtons() {
        MediaLibrarySession s = session;
        String key = buttonsKey();
        if (s == null || key.equals(buttonsKey)) return;
        buttonsKey = key;
        try {
            s.setMediaButtonPreferences(buttons());
        } catch (Throwable t) {
            Log.e(TAG, "setMediaButtonPreferences failed", t);
        }
    }

    private static String repeatName(int mode) {
        return mode == Player.REPEAT_MODE_ONE ? "one" : mode == Player.REPEAT_MODE_ALL ? "all" : "off";
    }

    /** Like, Shuffle, Repeat (in that order; stock Android 13+ shows the first two beside prev/next). */
    private ImmutableList<CommandButton> buttons() {
        ExoPlayer p = player;
        boolean liked = currentLiked();
        boolean shuffle = shuffleOn;
        int mode = p == null ? Player.REPEAT_MODE_OFF : p.getRepeatMode();
        CommandButton like = new CommandButton.Builder(liked ? CommandButton.ICON_HEART_FILLED : CommandButton.ICON_HEART_UNFILLED)
            .setCustomIconResId(liked ? R.drawable.ic_media_heart_filled : R.drawable.ic_media_heart_outline)
            .setDisplayName(getString(liked ? R.string.nocturne_media_unlike : R.string.nocturne_media_like))
            .setSessionCommand(LIKE)
            .build();
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
        return ImmutableList.of(like, shuf, repeat);
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
            folder(MediaIds.ARTISTS, getString(R.string.nocturne_auto_artists)));
    }

    private MediaItem nodeItem(Library.Node n) {
        MediaMetadata.Builder md;
        MediaItem.Builder b = new MediaItem.Builder().setMediaId(n.id);
        if (n.track != null) {
            md = songMeta(n.track.title, n.track.artist, n.track.album, n.track.artUrl, n.track.durationMs);
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
        Log.w(TAG, "library request failed: " + t.getClass().getSimpleName());
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
                int[] sl = MediaIds.slice(6, MediaIds.window(page, pageSize));
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
                    Log.w(TAG, "search failed: " + t.getClass().getSimpleName());
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
                Log.w(TAG, "like failed: " + t.getClass().getSimpleName());
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
