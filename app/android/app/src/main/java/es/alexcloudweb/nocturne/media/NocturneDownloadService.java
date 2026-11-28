package es.alexcloudweb.nocturne.media;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Intent;
import androidx.annotation.Nullable;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadManager;
import androidx.media3.exoplayer.offline.DownloadNotificationHelper;
import androidx.media3.exoplayer.offline.DownloadService;
import androidx.media3.exoplayer.scheduler.PlatformScheduler;
import androidx.media3.exoplayer.scheduler.Scheduler;
import es.alexcloudweb.nocturne.MainActivity;
import es.alexcloudweb.nocturne.R;
import java.util.List;

/**
 * Foreground service that keeps downloads going with the app closed (progress notification, Wi-Fi
 * requirement via {@link DownloadsController}; the {@link PlatformScheduler} job restarts it when the
 * requirements are met again). Declared with {@code foregroundServiceType="dataSync"} by
 * scripts/patch-android.mjs.
 */
@UnstableApi
public final class NocturneDownloadService extends DownloadService {
    static final int FOREGROUND_NOTIFICATION_ID = 4101;
    static final int DONE_NOTIFICATION_ID = 4102;
    static final int JOB_ID = 4101;
    static final String CHANNEL_ID = "nocturne_downloads";

    @Nullable private DownloadNotificationHelper helper;

    public NocturneDownloadService() {
        super(FOREGROUND_NOTIFICATION_ID, DEFAULT_FOREGROUND_NOTIFICATION_UPDATE_INTERVAL, CHANNEL_ID, R.string.nocturne_dl_channel_name, 0);
    }

    @Override
    protected DownloadManager getDownloadManager() {
        return DownloadsController.get(this).manager();
    }

    @Nullable
    @Override
    protected Scheduler getScheduler() {
        try {
            return new PlatformScheduler(this, JOB_ID);
        } catch (RuntimeException e) {
            return null;
        }
    }

    @Override
    protected Notification getForegroundNotification(List<Download> downloads, int notMetRequirements) {
        if (helper == null) helper = new DownloadNotificationHelper(this, CHANNEL_ID);
        PendingIntent open = PendingIntent.getActivity(
            this, 0, new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return helper.buildProgressNotification(this, R.drawable.ic_stat_nocturne, open, null, downloads, notMetRequirements);
    }
}
