package es.alexcloudweb.nocturne.media;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import androidx.annotation.Nullable;

/** Native connectivity: "is there a validated network" and "is it unmetered (Wi-Fi)". */
final class NetMonitor {
    interface Listener {
        void onChanged(boolean online);
    }

    private NetMonitor() {}

    @Nullable
    private static ConnectivityManager cm(Context c) {
        return (ConnectivityManager) c.getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    static boolean isOnline(Context c) {
        ConnectivityManager m = cm(c);
        if (m == null) return true; // unknown: let the request decide
        Network n = m.getActiveNetwork();
        NetworkCapabilities caps = n == null ? null : m.getNetworkCapabilities(n);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    static boolean isUnmetered(Context c) {
        ConnectivityManager m = cm(c);
        if (m == null) return false;
        Network n = m.getActiveNetwork();
        NetworkCapabilities caps = n == null ? null : m.getNetworkCapabilities(n);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
    }

    /** Registers a default-network callback; returns the callback to hand to {@link #unwatch}. */
    @Nullable
    static ConnectivityManager.NetworkCallback watch(Context c, Listener l) {
        ConnectivityManager m = cm(c);
        if (m == null) return null;
        ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                l.onChanged(true);
            }

            @Override
            public void onLost(Network network) {
                l.onChanged(isOnline(c));
            }
        };
        try {
            m.registerDefaultNetworkCallback(cb);
        } catch (RuntimeException e) {
            return null;
        }
        return cb;
    }

    static void unwatch(Context c, @Nullable ConnectivityManager.NetworkCallback cb) {
        ConnectivityManager m = cm(c);
        if (m == null || cb == null) return;
        try {
            m.unregisterNetworkCallback(cb);
        } catch (RuntimeException ignored) {
            /* already gone */
        }
    }
}
