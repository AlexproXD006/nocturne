package es.alexcloudweb.nocturne.share;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Pure (no Android classes) description of Instagram's "Add to story" intent, so it can be unit
 * tested on the JVM. {@link NocturneSharePlugin} turns a {@link Spec} into a real {@code Intent}.
 * See https://developers.facebook.com/docs/instagram-platform/sharing-to-stories/
 */
public final class InstagramStory {
    public static final String ACTION = "com.instagram.share.ADD_TO_STORY";
    public static final String PACKAGE = "com.instagram.android";
    public static final String MIME = "image/png";
    public static final String EXTRA_SOURCE = "source_application";
    public static final String EXTRA_STICKER = "interactive_asset_uri";
    public static final String EXTRA_TOP = "top_background_color";
    public static final String EXTRA_BOTTOM = "bottom_background_color";
    /** Sticker PNGs older than this are deleted from the cache on the next share. */
    public static final long MAX_AGE_MS = 60L * 60L * 1000L;
    /** Hard cap for the decoded PNG (the JS side aims for ~1 MB). */
    public static final int MAX_BYTES = 4 * 1024 * 1024;

    private static final Pattern APP_ID = Pattern.compile("^\\d{5,25}$");
    private static final Pattern COLOR = Pattern.compile("^#[0-9a-fA-F]{6}$");

    private InstagramStory() {}

    public static boolean isValidAppId(String id) {
        return id != null && APP_ID.matcher(id.trim()).matches();
    }

    public static boolean isValidColor(String c) {
        return c != null && COLOR.matcher(c).matches();
    }

    /** {@code #RRGGBB} as given (lower-cased), or the fallback when malformed. */
    public static String colorOr(String c, String fallback) {
        return isValidColor(c) ? c.toLowerCase(Locale.ROOT) : fallback;
    }

    /** File name for the cached sticker; only digits so it can never escape the cache folder. */
    public static String stickerFileName(long now) {
        return "story-" + Math.abs(now) + ".png";
    }

    public static final class Spec {
        public final String action = ACTION;
        public final String type = MIME;
        /** Instagram's package: URI permission grantee and {@code resolveActivity} target. */
        public final String targetPackage = PACKAGE;
        public final Map<String, String> extras;

        Spec(Map<String, String> extras) {
            this.extras = extras;
        }
    }

    /** Extras for the intent; {@code stickerUri} is the FileProvider content URI as a string. */
    public static Spec spec(String appId, String stickerUri, String topColor, String bottomColor) {
        if (!isValidAppId(appId)) throw new IllegalArgumentException("invalid appId");
        if (stickerUri == null || !stickerUri.startsWith("content://")) throw new IllegalArgumentException("invalid sticker uri");
        Map<String, String> m = new LinkedHashMap<>();
        m.put(EXTRA_SOURCE, appId.trim());
        m.put(EXTRA_STICKER, stickerUri);
        m.put(EXTRA_TOP, colorOr(topColor, "#1c2433"));
        m.put(EXTRA_BOTTOM, colorOr(bottomColor, "#080b12"));
        return new Spec(m);
    }
}
