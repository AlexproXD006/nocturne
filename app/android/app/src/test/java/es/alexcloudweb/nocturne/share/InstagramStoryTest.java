package es.alexcloudweb.nocturne.share;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.Arrays;
import org.junit.Test;

public class InstagramStoryTest {
    @Test
    public void constantsMatchMetaDocs() {
        assertEquals("com.instagram.share.ADD_TO_STORY", InstagramStory.ACTION);
        assertEquals("com.instagram.android", InstagramStory.PACKAGE);
        assertEquals("image/png", InstagramStory.MIME);
    }

    @Test
    public void specCarriesAllExtrasInOrder() {
        InstagramStory.Spec s = InstagramStory.spec("1234567890123456", "content://es.alexcloudweb.nocturne.fileprovider/x/story-1.png", "#AABBCC", "#001122");
        assertEquals(Arrays.asList("source_application", "interactive_asset_uri", "top_background_color", "bottom_background_color"), new ArrayList<>(s.extras.keySet()));
        assertEquals("1234567890123456", s.extras.get("source_application"));
        assertEquals("content://es.alexcloudweb.nocturne.fileprovider/x/story-1.png", s.extras.get("interactive_asset_uri"));
        assertEquals("#aabbcc", s.extras.get("top_background_color"));
        assertEquals("#001122", s.extras.get("bottom_background_color"));
        assertEquals("image/png", s.type);
        assertEquals("com.instagram.android", s.targetPackage);
    }

    @Test
    public void badColoursFallBack() {
        InstagramStory.Spec s = InstagramStory.spec("12345", "content://a/b", "red", null);
        assertEquals("#1c2433", s.extras.get("top_background_color"));
        assertEquals("#080b12", s.extras.get("bottom_background_color"));
    }

    @Test
    public void rejectsBadAppIdAndUri() {
        for (String id : new String[] {null, "", "abc", "1234", "12 345", "1234567890123456789012345678"}) {
            assertFalse(id, InstagramStory.isValidAppId(id));
            try {
                InstagramStory.spec(id, "content://a/b", "#000000", "#000000");
                fail("accepted " + id);
            } catch (IllegalArgumentException expected) {
                // ok
            }
        }
        try {
            InstagramStory.spec("12345", "file:///sdcard/x.png", "#000000", "#000000");
            fail("accepted a file:// uri");
        } catch (IllegalArgumentException expected) {
            // ok
        }
        assertTrue(InstagramStory.isValidAppId(" 123456789 "));
    }

    @Test
    public void stickerFileNameCannotEscapeTheCacheFolder() {
        assertEquals("story-1700000000000.png", InstagramStory.stickerFileName(1700000000000L));
        assertEquals("story-5.png", InstagramStory.stickerFileName(-5));
    }
}
