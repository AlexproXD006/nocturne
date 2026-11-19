package es.alexcloudweb.nocturne.updates;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import es.alexcloudweb.nocturne.diag.AppLog;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import es.alexcloudweb.nocturne.MainActivity;
import es.alexcloudweb.nocturne.R;

/**
 * Posts the "Nocturne X available" notification, at most once per version (the last notified
 * version lives in SharedPreferences, shared by the background worker and the in-app check).
 */
public final class UpdateNotifier {
    private UpdateNotifier() {}

    private static final String TAG = "NocturneUpdates";
    public static final String CHANNEL_ID = "nocturne_updates";
    static final int NOTIFICATION_ID = 0x4e55; // "NU"
    /** Action of the tap intent; MainActivity is singleTask so a running app gets onNewIntent. */
    public static final String ACTION_SHOW_UPDATE = "es.alexcloudweb.nocturne.action.SHOW_UPDATE";
    public static final String EXTRA_VERSION = "es.alexcloudweb.nocturne.extra.UPDATE_VERSION";

    /** The installed versionName, or null if it can't be read. */
    @Nullable
    @SuppressWarnings("deprecation")
    public static String installedVersion(@NonNull Context ctx) {
        try {
            PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return info.versionName;
        } catch (Throwable t) {
            return null;
        }
    }

    /** True when {@code version} is newer than the installed build. */
    public static boolean isNewerThanInstalled(@NonNull Context ctx, @Nullable String version) {
        String installed = installedVersion(ctx);
        return version != null && installed != null && VersionCompare.isNewer(version, installed);
    }

    private static boolean canPost(@NonNull Context ctx) {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!nm.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager sys = ctx.getSystemService(NotificationManager.class);
            NotificationChannel ch = sys == null ? null : sys.getNotificationChannel(CHANNEL_ID);
            if (ch != null && ch.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        }
        return true;
    }

    private static void ensureChannel(@NonNull Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager sys = ctx.getSystemService(NotificationManager.class);
        if (sys == null || sys.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, ctx.getString(R.string.nocturne_update_channel_name), NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription(ctx.getString(R.string.nocturne_update_channel_description));
        sys.createNotificationChannel(ch);
    }

    private static int smallIcon(@NonNull Context ctx) {
        int id = ctx.getResources().getIdentifier("ic_stat_nocturne", "drawable", ctx.getPackageName());
        return id != 0 ? id : ctx.getApplicationInfo().icon;
    }

    /**
     * Posts the notification unless this version was already notified, isn't newer than the
     * installed build, or notifications are off (then nothing is recorded, so it is retried later).
     * Returns true when a notification was posted. Never throws.
     */
    public static synchronized boolean notifyOnce(@NonNull Context context, @Nullable String rawVersion) {
        try {
            Context ctx = context.getApplicationContext();
            if (!UpdatePrefs.isValidVersion(rawVersion)) return false;
            String version = rawVersion.trim();
            if (!isNewerThanInstalled(ctx, version)) return false;
            String last = UpdatePrefs.lastNotified(ctx);
            if (last != null && VersionCompare.compare(last, version) == 0) return false;
            ensureChannel(ctx);
            if (!canPost(ctx)) return false;

            Intent tap = new Intent(ctx, MainActivity.class)
                .setAction(ACTION_SHOW_UPDATE)
                .putExtra(EXTRA_VERSION, version)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(
                ctx, NOTIFICATION_ID, tap, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

            NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(smallIcon(ctx))
                .setContentTitle(ctx.getString(R.string.nocturne_update_title, version))
                .setContentText(ctx.getString(R.string.nocturne_update_text))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true);
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, b.build());
            UpdatePrefs.setLastNotified(ctx, version);
            return true;
        } catch (Throwable t) {
            AppLog.w(TAG, "update notification failed", t);
            return false;
        }
    }

    /** Removes a posted update notification (logout). */
    static void cancel(@NonNull Context ctx) {
        try {
            NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID);
        } catch (Throwable t) {
            AppLog.w(TAG, "cancel failed", t);
        }
    }
}
