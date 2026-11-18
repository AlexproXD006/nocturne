package es.alexcloudweb.nocturne.media;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import androidx.annotation.Nullable;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The signed-in session, kept where the media service can read it with no WebView (Android Auto cold
 * start, phone locked). Encrypted with an AES-GCM key held in the Android Keystore; the tokens are never
 * logged.
 */
final class NocturneAuth {
    private static final String TAG = "NocturneAuth";
    private static final String PREFS = "nocturne_native_auth";
    private static final String FIELD = "blob";
    private static final String KEY_ALIAS = "nocturne_native_auth_key";

    static final class Session {
        final String serverUrl;
        final String accessToken;
        final String refreshToken;
        /** Epoch ms. */
        final long expiresAt;
        final String userId;

        Session(String serverUrl, String accessToken, String refreshToken, long expiresAt, String userId) {
            this.serverUrl = serverUrl.replaceAll("/+$", "");
            this.accessToken = accessToken;
            this.refreshToken = refreshToken;
            this.expiresAt = expiresAt;
            this.userId = userId == null ? "" : userId;
        }

        Session withTokens(String access, String refresh, long expires) {
            return new Session(serverUrl, access, refresh, expires, userId);
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject()
                .put("serverUrl", serverUrl)
                .put("accessToken", accessToken)
                .put("refreshToken", refreshToken)
                .put("expiresAt", expiresAt)
                .put("userId", userId);
        }

        @Nullable
        static Session fromJson(@Nullable JSONObject o) {
            if (o == null) return null;
            String server = o.optString("serverUrl", "");
            String access = o.optString("accessToken", "");
            String refresh = o.optString("refreshToken", "");
            if (server.isEmpty() || access.isEmpty() || refresh.isEmpty()) return null;
            return new Session(server, access, refresh, o.optLong("expiresAt", 0), o.optString("userId", ""));
        }
    }

    private NocturneAuth() {}

    @Nullable
    static synchronized Session load(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String blob = sp.getString(FIELD, null);
            if (blob == null) return null;
            byte[] all = Base64.decode(blob, Base64.NO_WRAP);
            if (all.length < 13) return null;
            byte[] iv = new byte[12];
            System.arraycopy(all, 0, iv, 0, 12);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            byte[] plain = c.doFinal(all, 12, all.length - 12);
            return Session.fromJson(new JSONObject(new String(plain, StandardCharsets.UTF_8)));
        } catch (Throwable t) {
            Log.w(TAG, "stored session unreadable: " + t.getClass().getSimpleName());
            return null;
        }
    }

    static synchronized void save(Context ctx, @Nullable Session s) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (s == null) {
            sp.edit().remove(FIELD).apply();
            return;
        }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] enc = c.doFinal(s.toJson().toString().getBytes(StandardCharsets.UTF_8));
            byte[] all = new byte[iv.length + enc.length];
            System.arraycopy(iv, 0, all, 0, iv.length);
            System.arraycopy(enc, 0, all, iv.length, enc.length);
            sp.edit().putString(FIELD, Base64.encodeToString(all, Base64.NO_WRAP)).apply();
        } catch (Throwable t) {
            Log.w(TAG, "could not store session: " + t.getClass().getSimpleName());
        }
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(
                new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            );
            return kg.generateKey();
        }
        return (SecretKey) ks.getKey(KEY_ALIAS, null);
    }
}
