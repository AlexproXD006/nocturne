package es.alexcloudweb.nocturne.media;

import android.content.Context;
import androidx.annotation.Nullable;
import es.alexcloudweb.nocturne.diag.AppLog;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Per-track offline extras next to the audio cache: the track metadata JSON, the lyrics JSON and the
 * 512 px cover. Fetched with one {@code /v1/tracks/{id}/offline-manifest} call (signed art URL included);
 * deleted together with the audio when the auto cache evicts a track, or when a download is removed.
 * Files: {@code files/offline/meta/<safe id>/{meta.json,lyrics.json,art.jpg}}.
 */
final class OfflineMeta {
    private static final String TAG = "OfflineMeta";
    private static final int MAX_ART = 2 * 1024 * 1024;

    private OfflineMeta() {}

    /** File-system safe directory name for a track id (ids may hold any character). */
    static String safe(String id) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') sb.append(c);
            else sb.append('~').append(Integer.toHexString(c));
        }
        return sb.length() == 0 ? "_" : sb.toString();
    }

    private static File dir(Context c, String id) {
        return new File(c.getApplicationContext().getFilesDir(), "offline/meta/" + safe(id));
    }

    static boolean has(Context c, String id) {
        return new File(dir(c, id), "meta.json").isFile();
    }

    static void delete(Context c, String id) {
        File d = dir(c, id);
        File[] files = d.listFiles();
        if (files != null) for (File f : files) f.delete();
        d.delete();
    }

    @Nullable
    static File art(Context c, String id) {
        File f = new File(dir(c, id), "art.jpg");
        return f.isFile() ? f : null;
    }

    @Nullable
    static JSONObject lyrics(Context c, String id) {
        return readJson(new File(dir(c, id), "lyrics.json"));
    }

    @Nullable
    static JSONObject meta(Context c, String id) {
        return readJson(new File(dir(c, id), "meta.json"));
    }

    /** Fetches and stores whatever is missing. Blocking: call off the main thread. Never throws. */
    static void fetch(Context c, NocturneApi api, String id) {
        try {
            if (has(c, id) && art(c, id) != null) return;
            JSONObject m = api.getJson("/v1/tracks/" + NocturneApi.pathId(id) + "/offline-manifest");
            File d = dir(c, id);
            if (!d.isDirectory() && !d.mkdirs()) return;
            JSONObject lyr = m.optJSONObject("lyrics");
            if (lyr != null) write(new File(d, "lyrics.json"), lyr.toString().getBytes(StandardCharsets.UTF_8));
            JSONObject art = m.optJSONObject("art");
            String artUrl = art == null ? "" : art.optString("url", "");
            if (!artUrl.isEmpty()) {
                byte[] bytes = download(artUrl);
                if (bytes != null) write(new File(d, "art.jpg"), bytes);
            }
            JSONObject track = m.optJSONObject("track");
            // meta.json last: its presence means "the rest was attempted".
            write(new File(d, "meta.json"), (track == null ? new JSONObject() : track).toString().getBytes(StandardCharsets.UTF_8));
        } catch (Throwable t) {
            AppLog.w(TAG, "meta fetch failed: " + t.getClass().getSimpleName());
        }
    }

    @Nullable
    private static byte[] download(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(15_000);
            conn.setRequestProperty("User-Agent", "Nocturne-Android");
            if (conn.getResponseCode() != 200) return null;
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > MAX_ART) return null;
                }
                return out.toByteArray();
            }
        } catch (IOException e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void write(File f, byte[] bytes) throws IOException {
        File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(bytes);
        }
        if (!tmp.renameTo(f)) {
            f.delete();
            if (!tmp.renameTo(f)) throw new IOException("rename failed");
        }
    }

    @Nullable
    private static JSONObject readJson(File f) {
        if (!f.isFile() || f.length() > 4 * 1024 * 1024) return null;
        try (InputStream in = new java.io.FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new JSONObject(out.toString("UTF-8"));
        } catch (Exception e) {
            return null;
        }
    }
}
