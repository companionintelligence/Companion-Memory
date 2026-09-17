package com.companionintelligence.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Probe whether Firebase/FCM was initialized for this process.
 *
 * {@code @capacitor/push-notifications} calls {@code FirebaseMessaging.getInstance()}
 * from {@code register()}, which throws and kills the CapacitorPlugins thread when
 * {@code google-services.json} was not applied at build time. JS {@code try/catch}
 * cannot recover from that. Gate remote-push registration on this probe instead.
 *
 * Uses reflection so the app module does not need a direct Firebase compile
 * dependency (messaging still arrives transitively via the Capacitor push plugin).
 */
@CapacitorPlugin(name = "FcmStatus")
public class FcmStatusPlugin extends Plugin {

    @PluginMethod
    public void isConfigured(PluginCall call) {
        boolean configured = false;
        try {
            Class<?> firebaseApp = Class.forName("com.google.firebase.FirebaseApp");
            firebaseApp.getMethod("getInstance").invoke(null);
            configured = true;
        } catch (Throwable ignored) {
            // Class missing, or Default FirebaseApp not initialized.
        }

        JSObject result = new JSObject();
        result.put("configured", configured);
        call.resolve(result);
    }
}
