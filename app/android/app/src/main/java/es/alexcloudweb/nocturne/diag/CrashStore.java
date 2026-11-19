package es.alexcloudweb.nocturne.diag;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/** Crash reports as small JSON files (kind, version, android, device, at, trace). Keeps the newest {@link #MAX_FILES}. */
public final class CrashStore {
    public static final int MAX_FILES = 5;
    private final File dir;

    public CrashStore(File dir) {
        this.dir = dir;
    }

    public static String stackOf(Throwable t) {
        java.io.StringWriter sw = new java.io.StringWriter();
        java.io.PrintWriter pw = new java.io.PrintWriter(sw);
        t.printStackTrace(pw); // includes the cause chain
        pw.flush();
        return sw.toString();
    }

    public static JSONObject report(String kind, String version, String android, String device, long at, String trace) {
        try {
            return new JSONObject()
                .put("kind", kind)
                .put("version", version == null ? "" : version)
                .put("android", android == null ? "" : android)
                .put("device", device == null ? "" : device)
                .put("at", at)
                .put("trace", DiagScrub.scrub(trace));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    /** Stores one report; best effort (never throws). Returns whether it was written. */
    public synchronized boolean write(JSONObject report) {
        try {
            if (!dir.isDirectory() && !dir.mkdirs()) return false;
            File f = new File(dir, "crash-" + System.currentTimeMillis() + "-" + (int) (Math.random() * 1000) + ".json");
            try (FileOutputStream os = new FileOutputStream(f)) {
                os.write(report.toString().getBytes(StandardCharsets.UTF_8));
                os.getFD().sync();
            }
            prune();
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    private File[] files() {
        File[] fs = dir.listFiles((d, n) -> n.startsWith("crash-") && n.endsWith(".json"));
        if (fs == null) return new File[0];
        Arrays.sort(fs, Comparator.comparing(File::getName));
        return fs;
    }

    private void prune() {
        File[] fs = files();
        for (int i = 0; i < fs.length - MAX_FILES; i++) fs[i].delete();
    }

    /** Oldest first. Unreadable files are deleted. */
    public synchronized List<JSONObject> list() {
        List<JSONObject> out = new ArrayList<>();
        for (File f : files()) {
            try (FileInputStream in = new FileInputStream(f)) {
                if (f.length() > 200_000) throw new IOException("too big");
                byte[] b = new byte[(int) f.length()];
                int n = in.read(b);
                JSONObject o = new JSONObject(new String(b, 0, Math.max(0, n), StandardCharsets.UTF_8));
                o.put("id", f.getName());
                out.add(o);
            } catch (IOException | JSONException | RuntimeException e) {
                f.delete();
            }
        }
        return out;
    }

    public synchronized void clear() {
        for (File f : files()) f.delete();
    }
}
