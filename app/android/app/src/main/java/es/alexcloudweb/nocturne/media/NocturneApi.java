package es.alexcloudweb.nocturne.media;

import android.content.Context;
import android.net.Uri;
import android.util.Log;
import androidx.annotation.Nullable;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Minimal Nocturne server client for the media service: Bearer token from {@link NocturneAuth}, one
 * refresh-and-retry on 401 (the refresh token rotates, so the new pair is stored and announced to the
 * WebView), signed stream URLs cached until shortly before they expire. Blocking: call off the main thread.
 * Tokens are never logged.
 */
final class NocturneApi {
    private static final String TAG = "NocturneApi";
    private static final long EXPIRY_SKEW_MS = 30_000;
    private static final int MAX_BODY = 8 * 1024 * 1024;

    /** The server rejected the session (refresh failed): the user has to sign in again in the app. */
    static final class AuthException extends IOException {
        AuthException(String m) {
            super(m);
        }
    }

    /** A non-2xx answer. */
    static final class HttpException extends IOException {
        final int status;

        HttpException(int status) {
            super("HTTP " + status);
            this.status = status;
        }
    }

    interface SessionListener {
        void onSessionRefreshed(NocturneAuth.Session session);
    }

    private static final class CachedUrl {
        final String url;
        final long expiresAt;

        CachedUrl(String url, long expiresAt) {
            this.url = url;
            this.expiresAt = expiresAt;
        }
    }

    private static NocturneApi instance;

    static synchronized NocturneApi get(Context ctx) {
        if (instance == null) instance = new NocturneApi(ctx.getApplicationContext());
        return instance;
    }

    private final Context app;
    private final Map<String, CachedUrl> streams = new ConcurrentHashMap<>();
    @Nullable private volatile NocturneAuth.Session session;
    @Nullable private volatile SessionListener listener;
    private boolean loaded;

    private NocturneApi(Context app) {
        this.app = app;
    }

    void setListener(@Nullable SessionListener l) {
        listener = l;
    }

    @Nullable
    synchronized NocturneAuth.Session session() {
        if (!loaded) {
            loaded = true;
            session = NocturneAuth.load(app);
        }
        return session;
    }

    boolean hasSession() {
        return session() != null;
    }

    /** From the WebView (login / refresh / logout). */
    synchronized void setSession(@Nullable NocturneAuth.Session s) {
        loaded = true;
        NocturneAuth.Session prev = session;
        // Keep a newer token pair this process already refreshed on its own.
        if (s != null && prev != null && prev.serverUrl.equals(s.serverUrl) && prev.expiresAt > s.expiresAt) return;
        if (s == null || prev == null || !prev.userId.equals(s.userId) || !prev.serverUrl.equals(s.serverUrl)) streams.clear();
        session = s;
        NocturneAuth.save(app, s);
    }

    private synchronized NocturneAuth.Session refresh(NocturneAuth.Session stale) throws IOException {
        NocturneAuth.Session cur = session();
        if (cur == null) throw new AuthException("signed out");
        // Someone else (the WebView, another thread) already refreshed while we waited.
        if (!cur.refreshToken.equals(stale.refreshToken)) return cur;
        JSONObject res;
        try {
            res = rawRequest("POST", cur.serverUrl, "/v1/auth/refresh", new JSONObject().put("refreshToken", cur.refreshToken), null);
        } catch (HttpException e) {
            if (e.status == 400 || e.status == 401 || e.status == 403) throw new AuthException("session expired");
            throw e;
        } catch (JSONException e) {
            throw new IOException("bad refresh request");
        }
        String access = res == null ? "" : res.optString("accessToken", "");
        String refreshToken = res == null ? "" : res.optString("refreshToken", "");
        if (access.isEmpty() || refreshToken.isEmpty()) throw new IOException("bad refresh response");
        double expiresIn = res.optDouble("expiresIn", 3600);
        long expiresAt = System.currentTimeMillis() + (long) ((expiresIn > 0 ? expiresIn : 3600) * 1000);
        NocturneAuth.Session next = cur.withTokens(access, refreshToken, expiresAt);
        session = next;
        NocturneAuth.save(app, next);
        SessionListener l = listener;
        if (l != null) {
            try {
                l.onSessionRefreshed(next);
            } catch (Throwable t) {
                Log.w(TAG, "session listener failed", t);
            }
        }
        return next;
    }

    /** GET returning the JSON object body. */
    JSONObject getJson(String path) throws IOException {
        JSONObject o = request("GET", path, null);
        return o == null ? new JSONObject() : o;
    }

    /** Authenticated request; returns null for 204/empty. Retries once after a refresh on 401. */
    @Nullable
    JSONObject request(String method, String path, @Nullable JSONObject body) throws IOException {
        NocturneAuth.Session s = session();
        if (s == null) throw new AuthException("signed out");
        if (s.expiresAt - EXPIRY_SKEW_MS <= System.currentTimeMillis()) s = refresh(s);
        try {
            return rawRequest(method, s.serverUrl, path, body, s.accessToken);
        } catch (HttpException e) {
            if (e.status != 401) throw e;
            s = refresh(s);
            return rawRequest(method, s.serverUrl, path, body, s.accessToken);
        }
    }

    /** Pre-signed audio URL for a track, cached until a minute before it expires. */
    String streamUrl(String trackId) throws IOException {
        CachedUrl c = streams.get(trackId);
        long now = System.currentTimeMillis();
        if (c != null && c.expiresAt - 60_000 > now) return c.url;
        JSONObject o = getJson("/v1/tracks/" + MediaIds.enc(trackId).replace("+", "%20") + "/stream");
        String url = o.optString("url", "");
        if (url.isEmpty()) throw new IOException("no stream url");
        long expires = now + 5 * 60_000;
        String iso = o.optString("expiresAt", "");
        if (!iso.isEmpty()) {
            try {
                expires = java.time.Instant.parse(iso).toEpochMilli();
            } catch (Throwable ignored) {
                /* keep the default */
            }
        }
        if (streams.size() > 64) streams.clear();
        streams.put(trackId, new CachedUrl(url, expires));
        return url;
    }

    void invalidateStream(String trackId) {
        streams.remove(trackId);
    }

    static String pathId(String id) {
        return MediaIds.enc(id).replace("+", "%20");
    }

    @Nullable
    private static JSONObject rawRequest(String method, String base, String path, @Nullable JSONObject body, @Nullable String token)
        throws IOException {
        IOException last = null;
        for (int attempt = 0; attempt < (method.equals("GET") ? 2 : 1); attempt++) {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(base + path).openConnection();
                c.setConnectTimeout(10_000);
                c.setReadTimeout(15_000);
                c.setRequestMethod(method);
                c.setRequestProperty("Accept", "application/json");
                c.setRequestProperty("User-Agent", "Nocturne-Android");
                if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
                if (body != null) {
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                    try (OutputStream out = c.getOutputStream()) {
                        out.write(bytes);
                    }
                }
                int status = c.getResponseCode();
                if (status < 200 || status >= 300) {
                    if (status >= 500 && attempt == 0 && method.equals("GET")) {
                        last = new HttpException(status);
                        sleepQuietly(400);
                        continue;
                    }
                    throw new HttpException(status);
                }
                if (status == 204) return null;
                String text = readAll(c.getInputStream());
                if (text.trim().isEmpty()) return null;
                try {
                    return new JSONObject(text);
                } catch (JSONException e) {
                    throw new IOException("bad response");
                }
            } catch (HttpException e) {
                throw e;
            } catch (IOException e) {
                last = e;
                if (attempt == 0 && method.equals("GET")) sleepQuietly(400);
            } finally {
                if (c != null) c.disconnect();
            }
        }
        throw last != null ? last : new IOException("request failed");
    }

    private static void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BODY) throw new IOException("response too large");
            }
            return out.toString("UTF-8");
        }
    }

    /** Query string builder: {@code query("offset", 0, "limit", 100)}. */
    static String query(Object... kv) {
        Uri.Builder b = new Uri.Builder();
        for (int i = 0; i + 1 < kv.length; i += 2) b.appendQueryParameter(String.valueOf(kv[i]), String.valueOf(kv[i + 1]));
        String q = b.build().getEncodedQuery();
        return q == null ? "" : "?" + q;
    }
}
