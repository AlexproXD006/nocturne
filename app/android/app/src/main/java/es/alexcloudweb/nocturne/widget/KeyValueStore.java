package es.alexcloudweb.nocturne.widget;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.Nullable;

/** String key/value storage; SharedPreferences in the app, a map in unit tests. */
public interface KeyValueStore {
    @Nullable
    String get(String key);

    void put(String key, String value);

    void remove(String key);

    /** The widgets' own preferences file. */
    static KeyValueStore prefs(Context ctx) {
        final SharedPreferences sp = ctx.getApplicationContext().getSharedPreferences("nocturne_widgets", Context.MODE_PRIVATE);
        return new KeyValueStore() {
            @Nullable
            @Override
            public String get(String key) {
                return sp.getString(key, null);
            }

            @Override
            public void put(String key, String value) {
                sp.edit().putString(key, value).apply();
            }

            @Override
            public void remove(String key) {
                sp.edit().remove(key).apply();
            }
        };
    }
}
