package es.alexcloudweb.nocturne.diag;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;

/** The last {@code max} log lines (scrubbed), mirrored in a small file so they survive a crash. Pure Java, thread-safe. */
public final class RingLog {
    private final File file;
    private final int max;
    private final ArrayDeque<String> lines = new ArrayDeque<>();
    private int sinceRewrite;
    private boolean loaded;

    public RingLog(File file, int max) {
        this.file = file;
        this.max = Math.max(10, max);
    }

    private void loadLocked() {
        if (loaded) return;
        loaded = true;
        if (!file.isFile() || file.length() > 512 * 1024) return;
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] b = new byte[(int) file.length()];
            int n = in.read(b);
            if (n > 0) for (String l : new String(b, 0, n, StandardCharsets.UTF_8).split("\n")) if (!l.isEmpty()) lines.addLast(l);
            while (lines.size() > max) lines.removeFirst();
        } catch (IOException | RuntimeException ignored) {
            /* start empty */
        }
    }

    public synchronized void add(String line) {
        loadLocked();
        String l = DiagScrub.scrub(line).replace('\n', ' ').replace('\r', ' ');
        if (l.length() > 400) l = l.substring(0, 400);
        lines.addLast(l);
        boolean trimmed = false;
        while (lines.size() > max) {
            lines.removeFirst();
            trimmed = true;
        }
        try {
            if (trimmed && ++sinceRewrite >= max) {
                sinceRewrite = 0;
                write(false);
            } else {
                write(true);
            }
        } catch (IOException | RuntimeException ignored) {
            /* the in-memory ring still works */
        }
    }

    private void write(boolean append) throws IOException {
        File dir = file.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return;
        try (BufferedWriter w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(file, append), StandardCharsets.UTF_8))) {
            if (append) {
                w.write(lines.peekLast());
                w.write('\n');
            } else {
                for (String s : lines) {
                    w.write(s);
                    w.write('\n');
                }
            }
        }
    }

    public synchronized String snapshot() {
        loadLocked();
        return String.join("\n", lines);
    }
}
