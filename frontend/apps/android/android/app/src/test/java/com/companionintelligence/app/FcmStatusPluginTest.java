package com.companionintelligence.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.junit.Test;

/**
 * What {@code FcmStatusPlugin.isConfigured} actually puts on the wire.
 *
 * <p>No mocking framework and no Android runtime is needed: {@link PluginCall}'s
 * constructor is public and {@code resolve}/{@code reject} are overridable, so a
 * recording subclass captures the real payload the real plugin produced.
 *
 * <p>Off-device the probe always lands in the catch branch, and for the realistic
 * reason: {@code com.google.firebase.FirebaseApp} IS on this module's unit-test
 * runtime classpath (transitively, via :capacitor-push-notifications ->
 * firebase-messaging), so {@code Class.forName} succeeds and the reflective
 * {@code getInstance()} throws "Default FirebaseApp is not initialized" wrapped in
 * an InvocationTargetException. That is the exact path a real APK built without
 * google-services.json takes, so the false-side assertions below are testing the
 * production behaviour rather than an artefact of the test environment.
 */
public class FcmStatusPluginTest {

    @Test
    public void isConfigured_resolves_a_json_boolean_not_a_string() {
        RecordingCall call = new RecordingCall();

        new FcmStatusPlugin().isConfigured(call);

        assertNotNull("isConfigured resolved without a payload; the web side reads result.configured.", call.payload);

        // The web side compares with `result.configured === true`, so a JSON string "false"
        // -- or, worse, a JSON string "true" -- is not merely cosmetic: it permanently
        // disables (or enables) Android remote push. JSObject.put(String, Object) accepts a
        // String happily, so nothing but this assertion catches the swap.
        Object configured = call.payload.opt("configured");
        assertNotNull("The resolved payload has no \"configured\" key. Payload was: " + call.payload, configured);
        assertTrue(
            "\"configured\" must be a JSON boolean, because registerNativePushToken.ts uses a strict `=== true` "
                + "comparison. It was a " + configured.getClass().getName() + ": " + call.payload,
            configured instanceof Boolean
        );

        // Serialized shape, i.e. what the bridge really hands to JavaScript.
        assertEquals(
            "The payload the bridge sends to the web layer changed shape.",
            "{\"configured\":false}",
            call.payload.toString()
        );
    }

    /**
     * The whole reason this plugin exists is that the Firebase probe throws when FCM was
     * not wired up. It must convert that into a resolved {@code false}: rejecting would
     * make the JS {@code catch} treat it the same way, but propagating the throwable up
     * out of a plugin method takes down the CapacitorPlugins thread -- which is the crash
     * the plugin was written to avoid in the first place.
     */
    @Test
    public void a_failing_firebase_probe_resolves_false_rather_than_throwing_or_rejecting() {
        RecordingCall call = new RecordingCall();

        new FcmStatusPlugin().isConfigured(call);

        assertEquals("isConfigured must resolve exactly once.", 1, call.resolveCount);
        assertNull("isConfigured must never reject; it answers with a boolean. Rejected: " + call.rejectMessage, call.rejectMessage);
        assertEquals(
            "With no initialized FirebaseApp the probe must report false. Reporting true here would send the app "
                + "straight into PushNotifications.register(), which is the process-killing crash this plugin gates.",
            Boolean.FALSE,
            call.payload.opt("configured")
        );
    }

    /**
     * The payload key is a string on this side and a property access on the other, with
     * nothing in between to check them. Derive it from the real payload and look for the
     * exact comparison the web bundle performs.
     */
    @Test
    public void the_payload_key_is_the_one_the_web_bundle_reads() {
        RecordingCall call = new RecordingCall();

        new FcmStatusPlugin().isConfigured(call);

        assertEquals(
            "isConfigured resolves exactly one field. If a second is added on purpose, update this test and "
                + "registerNativePushToken.ts together. Payload was: " + call.payload,
            1,
            call.payload.length()
        );

        String key = call.payload.keys().next();
        String js = ProjectFiles.read(ProjectFiles.inRepo("frontend/apps/web/src/lib/registerNativePushToken.ts"));

        assertTrue(
            "registerNativePushToken.ts does not contain `result." + key + " === true`, so the native payload key "
                + "and the web bundle's property access have drifted apart. Android remote push would stay off.",
            js.contains("result." + key + " === true")
        );
    }

    /**
     * Captures what the plugin did instead of talking to a bridge. Every {@code reject}
     * overload on PluginCall funnels into the four-argument one, so overriding that single
     * method catches all of them.
     */
    private static final class RecordingCall extends PluginCall {

        JSObject payload;
        int resolveCount;
        String rejectMessage;

        RecordingCall() {
            // The MessageHandler is only touched by the base-class implementations, all of
            // which are overridden below, so null is safe here and keeps the test free of
            // any Android or WebView dependency.
            super(null, "FcmStatus", "cb-1", "isConfigured", new JSObject());
        }

        @Override
        public void resolve(JSObject data) {
            payload = data;
            resolveCount++;
        }

        @Override
        public void resolve() {
            resolveCount++;
        }

        @Override
        public void reject(String msg, String code, Exception ex, JSObject data) {
            rejectMessage = msg;
        }
    }
}
