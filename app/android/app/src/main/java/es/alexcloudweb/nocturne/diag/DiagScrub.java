package es.alexcloudweb.nocturne.diag;

import java.util.regex.Pattern;

/** Removes anything secret-looking from text that leaves the device in a diagnostic report. Pure Java. */
public final class DiagScrub {
    /** Hard cap on one report / log text (server accepts 64 KB). */
    public static final int MAX_CHARS = 40_000;

    private static final Pattern URL_QUERY = Pattern.compile("(?i)(https?://[^\\s?#\"'<>()]*)\\?[^\\s\"'<>()]*");
    private static final Pattern JWT = Pattern.compile("eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]*");
    private static final Pattern KEYED = Pattern.compile(
        "(?i)(authorization|bearer|token|password|passwd|secret|signature|api[_-]?key|cookie|session)([\"']?\\s*[:=]\\s*[\"']?|\\s+)[^\\s\"',;&)]+");
    private static final Pattern BEARER = Pattern.compile("(?i)\\bBearer\\s+[A-Za-z0-9._~+/=-]{8,}");

    private DiagScrub() {}

    public static String scrub(String s) {
        if (s == null) return "";
        String out = s.length() > MAX_CHARS * 2 ? s.substring(0, MAX_CHARS * 2) : s;
        out = URL_QUERY.matcher(out).replaceAll("$1?<redacted>");
        out = BEARER.matcher(out).replaceAll("Bearer <redacted>");
        out = JWT.matcher(out).replaceAll("<jwt>");
        out = KEYED.matcher(out).replaceAll("$1$2<redacted>");
        if (out.length() > MAX_CHARS) out = out.substring(0, MAX_CHARS) + "\n...[truncated]";
        return out;
    }
}
