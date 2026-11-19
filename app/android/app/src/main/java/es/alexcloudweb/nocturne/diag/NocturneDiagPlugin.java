package es.alexcloudweb.nocturne.diag;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;
import org.json.JSONObject;

/**
 * JS API ({@code registerPlugin('NocturneDiag')}), see platform/diagnostics.ts: {@code recordJsError},
 * {@code pending} (stored crash reports + device info), {@code discard}, {@code logSnapshot}.
 */
@CapacitorPlugin(name = "NocturneDiag")
public class NocturneDiagPlugin extends Plugin {
    private long lastJsAt;

    @PluginMethod
    public void recordJsError(PluginCall call) {
        try {
            long now = System.currentTimeMillis();
            if (now - lastJsAt > 5_000) {
                lastJsAt = now;
                String msg = call.getString("message", "");
                String stack = call.getString("stack", "");
                Diag.record("js", (msg == null ? "" : msg) + "\n" + (stack == null ? "" : stack));
            }
        } catch (Throwable ignored) {
            /* never fail the page */
        }
        call.resolve();
    }

    @PluginMethod
    public void pending(PluginCall call) {
        JSObject out = new JSObject();
        JSArray arr = new JSArray();
        try {
            CrashStore s = Diag.store();
            if (s != null) {
                List<JSONObject> l = s.list();
                for (JSONObject o : l) arr.put(o);
            }
        } catch (Throwable ignored) {
            /* empty */
        }
        out.put("reports", arr);
        call.resolve(out);
    }

    @PluginMethod
    public void discard(PluginCall call) {
        try {
            CrashStore s = Diag.store();
            if (s != null) s.clear();
        } catch (Throwable ignored) {
            /* ignore */
        }
        call.resolve();
    }

    @PluginMethod
    public void logSnapshot(PluginCall call) {
        JSObject out = new JSObject();
        out.put("log", Diag.logSnapshot());
        try {
            out.put("device", new JSObject(Diag.device().toString()));
        } catch (Throwable ignored) {
            /* optional */
        }
        call.resolve(out);
    }
}
