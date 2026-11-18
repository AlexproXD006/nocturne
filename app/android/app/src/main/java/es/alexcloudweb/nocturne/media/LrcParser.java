package es.alexcloudweb.nocturne.media;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Parses synced lyrics (LRC) and finds the line for a playback position. Pure Java (unit-tested). */
final class LrcParser {
    private static final Pattern STAMP = Pattern.compile("\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?\\]");

    private final long[] times;
    private final String[] lines;

    private LrcParser(long[] times, String[] lines) {
        this.times = times;
        this.lines = lines;
    }

    boolean isEmpty() {
        return times.length == 0;
    }

    int size() {
        return times.length;
    }

    String line(int index) {
        return index < 0 || index >= lines.length ? "" : lines[index];
    }

    /**
     * @param offsetMs shared per-track offset from the server (positive = lyrics later)
     */
    static LrcParser parse(String lrc, long offsetMs) {
        final class Entry {
            final long t;
            final String text;

            Entry(long t, String text) {
                this.t = t;
                this.text = text;
            }
        }
        List<Entry> entries = new ArrayList<>();
        if (lrc != null) {
            for (String raw : lrc.split("\\r?\\n")) {
                Matcher m = STAMP.matcher(raw);
                List<Long> stamps = new ArrayList<>();
                int end = 0;
                while (m.find() && m.start() == end) {
                    long min = Long.parseLong(m.group(1));
                    long sec = Long.parseLong(m.group(2));
                    long ms = 0;
                    String frac = m.group(3);
                    if (frac != null) {
                        ms = Long.parseLong(frac);
                        if (frac.length() == 1) ms *= 100;
                        else if (frac.length() == 2) ms *= 10;
                    }
                    stamps.add(min * 60_000 + sec * 1000 + ms);
                    end = m.end();
                }
                if (stamps.isEmpty()) continue; // metadata tags ([ar:...]) and blank lines
                String text = raw.substring(end).trim();
                for (long t : stamps) entries.add(new Entry(Math.max(0, t + offsetMs), text));
            }
        }
        Collections.sort(entries, (a, b) -> Long.compare(a.t, b.t));
        long[] times = new long[entries.size()];
        String[] lines = new String[entries.size()];
        for (int i = 0; i < times.length; i++) {
            times[i] = entries.get(i).t;
            lines[i] = entries.get(i).text;
        }
        return new LrcParser(times, lines);
    }

    /** Index of the last line starting at or before {@code positionMs}, or -1 before the first line. */
    int lineAt(long positionMs) {
        int lo = 0;
        int hi = times.length - 1;
        int found = -1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (times[mid] <= positionMs) {
                found = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return found;
    }
}
