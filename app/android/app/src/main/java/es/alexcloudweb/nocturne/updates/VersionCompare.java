package es.alexcloudweb.nocturne.updates;

import java.util.ArrayList;
import java.util.List;

/**
 * SemVer 2.0 precedence, pre-release aware. A line-for-line mirror of
 * {@code src/renderer/src/lib/version.ts} (compareVersions / isNewerVersion); keep them in sync.
 * Pure Java (no Android APIs) so it runs in JVM unit tests.
 */
public final class VersionCompare {
    private VersionCompare() {}

    private static final class Parts {
        final List<Integer> core = new ArrayList<>();
        final List<String> pre = new ArrayList<>();
    }

    private static int parseIntLoose(String s) {
        // Mirrors JS parseInt(x, 10) || 0: leading digits only, anything else is 0.
        int i = 0;
        String t = s.trim();
        boolean neg = false;
        if (i < t.length() && (t.charAt(i) == '-' || t.charAt(i) == '+')) {
            neg = t.charAt(i) == '-';
            i++;
        }
        long n = 0;
        int start = i;
        while (i < t.length() && Character.isDigit(t.charAt(i)) && i - start < 9) {
            n = n * 10 + (t.charAt(i) - '0');
            i++;
        }
        if (i == start) return 0;
        return (int) (neg ? -n : n);
    }

    private static boolean isNumeric(String s) {
        if (s.isEmpty()) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    private static Parts split(String v) {
        Parts p = new Parts();
        String s = v == null ? "" : v.trim();
        if (!s.isEmpty() && (s.charAt(0) == 'v' || s.charAt(0) == 'V')) s = s.substring(1);
        int plus = s.indexOf('+');
        if (plus != -1) s = s.substring(0, plus);
        int dash = s.indexOf('-');
        String coreStr = dash == -1 ? s : s.substring(0, dash);
        String preStr = dash == -1 ? "" : s.substring(dash + 1);
        for (String x : coreStr.split("\\.", -1)) p.core.add(parseIntLoose(x));
        if (!preStr.isEmpty()) {
            for (String x : preStr.split("\\.", -1)) p.pre.add(x);
        }
        return p;
    }

    /** &lt;0 when a &lt; b, 0 when equal, &gt;0 when a &gt; b. Null is treated as "". */
    public static int compare(String a, String b) {
        Parts x = split(a);
        Parts y = split(b);
        int len = Math.max(x.core.size(), y.core.size());
        for (int i = 0; i < len; i++) {
            int xi = i < x.core.size() ? x.core.get(i) : 0;
            int yi = i < y.core.size() ? y.core.get(i) : 0;
            if (xi != yi) return Integer.compare(xi, yi);
        }
        // Same core: a release outranks any of its pre-releases (1.0.4 > 1.0.4-beta.1).
        if (x.pre.isEmpty() || y.pre.isEmpty()) return Integer.compare(y.pre.size(), x.pre.size());
        int n = Math.max(x.pre.size(), y.pre.size());
        for (int i = 0; i < n; i++) {
            if (i >= x.pre.size()) return -1;
            if (i >= y.pre.size()) return 1;
            String p = x.pre.get(i);
            String q = y.pre.get(i);
            boolean pn = isNumeric(p);
            boolean qn = isNumeric(q);
            if (pn && qn) {
                int d = Integer.compare(parseIntLoose(p), parseIntLoose(q));
                if (d != 0) return d;
            } else if (pn != qn) {
                return pn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
            } else if (!p.equals(q)) {
                return p.compareTo(q) < 0 ? -1 : 1; // 'alpha' < 'beta' < 'rc'
            }
        }
        return 0;
    }

    /** True when {@code latest} is strictly newer than {@code installed}. */
    public static boolean isNewer(String latest, String installed) {
        return compare(latest, installed) > 0;
    }
}
