package es.alexcloudweb.nocturne;

import android.app.Application;
import es.alexcloudweb.nocturne.diag.Diag;

/** Installs the crash reporter before any activity, service or widget receiver of this process runs. */
public class NocturneApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Diag.install(this);
    }
}
