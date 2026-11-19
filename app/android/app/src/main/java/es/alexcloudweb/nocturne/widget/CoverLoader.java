package es.alexcloudweb.nocturne.widget;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.palette.graphics.Palette;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Cover art for the widgets: fetched once per track at no more than {@link #MAX_PX} (RemoteViews carry
 * their bitmaps over binder, so they stay small), cached in memory and on disk (the last cover survives a
 * process restart), rounded per use, plus the Palette swatches for the adaptive colours.
 * Blocking: only call off the main thread.
 */
final class CoverLoader {
    private static final String TAG = "NocturneWidget";
    static final int MAX_PX = 512;
    private static final int MAX_BYTES = 6 * 1024 * 1024;
    private static final String FILE = "widget_cover.jpg";
    private static final String KEY_TRACK = "cover.track";

    private static String memTrack = "";
    @Nullable private static Bitmap memBitmap;
    @Nullable private static int[] memPalette;

    private CoverLoader() {}

    /** The cover of {@code trackId} (memory, then disk, then {@code url}), or null. */
    @Nullable
    static synchronized Bitmap load(Context ctx, String trackId, String url) {
        if (trackId.isEmpty()) return null;
        if (trackId.equals(memTrack) && memBitmap != null) return memBitmap;
        KeyValueStore kv = KeyValueStore.prefs(ctx);
        File file = new File(ctx.getCacheDir(), FILE);
        Bitmap bmp = null;
        if (trackId.equals(kv.get(KEY_TRACK)) && file.isFile()) {
            bmp = BitmapFactory.decodeFile(file.getAbsolutePath());
        }
        if (bmp == null && url != null && !url.isEmpty()) {
            bmp = download(url);
            if (bmp != null) {
                store(file, bmp);
                kv.put(KEY_TRACK, trackId);
            }
        }
        if (bmp == null) return null;
        memTrack = trackId;
        memBitmap = bmp;
        memPalette = null;
        return bmp;
    }

    /** The last cover cached for {@code trackId} only if it is already there (never touches the network). */
    @Nullable
    static synchronized Bitmap cached(Context ctx, String trackId) {
        return load(ctx, trackId, "");
    }

    /** {dominant, vibrant, muted} swatch colours (0 = none) of the bitmap of {@code trackId}. */
    static synchronized int[] palette(String trackId, Bitmap bmp) {
        if (trackId.equals(memTrack) && memPalette != null) return memPalette;
        int[] out = new int[3];
        try {
            Palette p = Palette.from(bmp).maximumColorCount(16).generate();
            Palette.Swatch dom = p.getDominantSwatch();
            out[0] = dom == null ? 0 : dom.getRgb();
            int vib = p.getVibrantColor(0);
            if (vib == 0) vib = p.getLightVibrantColor(0);
            if (vib == 0) vib = p.getLightMutedColor(0);
            out[1] = vib;
            out[2] = p.getMutedColor(0);
        } catch (Throwable t) {
            Log.w(TAG, "palette failed", t);
        }
        if (trackId.equals(memTrack)) memPalette = out;
        return out;
    }

    @Nullable
    private static Bitmap download(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            if (c.getResponseCode() / 100 != 2) return null;
            byte[] data = readCapped(c.getInputStream());
            if (data == null) return null;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, o);
            o.inSampleSize = sampleSize(o.outWidth, o.outHeight, MAX_PX);
            o.inJustDecodeBounds = false;
            return BitmapFactory.decodeByteArray(data, 0, data.length, o);
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "cover download failed: " + e.getClass().getSimpleName());
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Largest power-of-two sample size that keeps both sides at least {@code target}. */
    static int sampleSize(int w, int h, int target) {
        int s = 1;
        while (w / (s * 2) >= target && h / (s * 2) >= target) s *= 2;
        return s;
    }

    @Nullable
    private static byte[] readCapped(InputStream in) throws IOException {
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = is.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BYTES) return null;
            }
            return out.toByteArray();
        }
    }

    private static void store(File file, Bitmap bmp) {
        try (FileOutputStream os = new FileOutputStream(file)) {
            bmp.compress(Bitmap.CompressFormat.JPEG, 88, os);
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "cover cache write failed");
        }
    }

    /** Square centre crop scaled to {@code sizePx}, corners rounded to {@code radiusFraction} of the side. */
    static Bitmap rounded(Bitmap src, int sizePx, float radiusFraction) {
        sizePx = Math.max(16, Math.min(MAX_PX, sizePx));
        Bitmap out = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        float r = sizePx * radiusFraction;
        canvas.drawRoundRect(new RectF(0, 0, sizePx, sizePx), r, r, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        int side = Math.min(src.getWidth(), src.getHeight());
        Rect from = new Rect((src.getWidth() - side) / 2, (src.getHeight() - side) / 2, (src.getWidth() + side) / 2, (src.getHeight() + side) / 2);
        canvas.drawBitmap(src, from, new Rect(0, 0, sizePx, sizePx), paint);
        return out;
    }
}
