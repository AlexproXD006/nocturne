package es.alexcloudweb.nocturne.share;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import es.alexcloudweb.nocturne.diag.AppLog;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Map;

/**
 * JS API ({@code registerPlugin('NocturneShare')}), see platform/instagramStory.ts:
 * {@code shareToInstagramStory({ imageBase64, appId, topColor, bottomColor })} writes the sticker PNG
 * to the cache, exposes it through the app FileProvider and starts Instagram's ADD_TO_STORY
 * activity. Resolves {@code { opened, installed }}; {@code installed:false} means the JS side should
 * fall back to the normal share sheet.
 */
@CapacitorPlugin(name = "NocturneShare")
public class NocturneSharePlugin extends Plugin {
    private static final String TAG = "NocturneShare";

    @PluginMethod
    public void shareToInstagramStory(PluginCall call) {
        try {
            String appId = call.getString("appId");
            String b64 = call.getString("imageBase64");
            if (!InstagramStory.isValidAppId(appId) || b64 == null || b64.isEmpty()) {
                call.reject("invalid arguments");
                return;
            }
            Context ctx = getContext();
            if (!isInstagramInstalled(ctx)) {
                JSObject r = new JSObject();
                r.put("opened", false);
                r.put("installed", false);
                call.resolve(r);
                return;
            }
            byte[] png = Base64.decode(b64, Base64.DEFAULT);
            if (png.length == 0 || png.length > InstagramStory.MAX_BYTES) {
                call.reject("invalid image");
                return;
            }
            File dir = new File(ctx.getCacheDir(), "stories");
            if (!dir.isDirectory() && !dir.mkdirs()) {
                call.reject("cache unavailable");
                return;
            }
            prune(dir);
            File file = new File(dir, InstagramStory.stickerFileName(System.currentTimeMillis()));
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(png);
            }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);

            InstagramStory.Spec spec = InstagramStory.spec(appId, uri.toString(), call.getString("topColor"), call.getString("bottomColor"));
            Intent intent = new Intent(spec.action);
            intent.setType(spec.type);
            intent.setPackage(spec.targetPackage);
            for (Map.Entry<String, String> e : spec.extras.entrySet()) {
                if (InstagramStory.EXTRA_STICKER.equals(e.getKey())) intent.putExtra(e.getKey(), uri);
                else intent.putExtra(e.getKey(), e.getValue());
            }
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.grantUriPermission(spec.targetPackage, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);

            if (intent.resolveActivity(ctx.getPackageManager()) == null) {
                JSObject r = new JSObject();
                r.put("opened", false);
                r.put("installed", false);
                call.resolve(r);
                return;
            }
            Activity a = getActivity();
            if (a != null) a.startActivity(intent);
            else ctx.startActivity(intent);
            JSObject r = new JSObject();
            r.put("opened", true);
            r.put("installed", true);
            call.resolve(r);
        } catch (Throwable t) {
            AppLog.w(TAG, "shareToInstagramStory failed", t);
            call.reject("share failed");
        }
    }

    private static boolean isInstagramInstalled(Context ctx) {
        try {
            ctx.getPackageManager().getPackageInfo(InstagramStory.PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /** Removes stale stickers so the cache never grows. */
    private static void prune(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - InstagramStory.MAX_AGE_MS;
        for (File f : files) {
            if (f.isFile() && f.lastModified() < cutoff) //noinspection ResultOfMethodCallIgnored
                f.delete();
        }
    }
}
