package com.companionintelligence.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import org.junit.Test;

/**
 * The FcmStatus bridge contract, which is pure reflection metadata on this side
 * and pure string lookup on the other. Capacitor discovers the plugin by the
 * {@code name} in its annotation, dispatches by method name, and refuses any
 * method without {@code @PluginMethod} -- all at runtime, none of it checked by
 * a compiler on either side of the boundary.
 *
 * <p>Getting any of it wrong is invisible: {@code window.Capacitor.Plugins.FcmStatus}
 * is simply {@code undefined}, {@code isRemotePushTransportReady()} returns false
 * for that reason (the same value it returns for a legitimately unconfigured
 * build), and Android never registers for remote push. There is no error to see.
 */
public class FcmStatusPluginContractTest {

    /** The one and only consumer of this plugin. */
    private static final String JS_CONSUMER = "frontend/apps/web/src/lib/registerNativePushToken.ts";

    // There is deliberately no test asserting annotation.name().equals("FcmStatus"). The id is
    // only meaningful relative to the JS lookup, and the test below pins exactly that by reading
    // the id out of the annotation and finding it in the consumer. A literal assertion here would
    // fire on a *coordinated* rename -- the one case where nothing is broken -- and stay silent on
    // nothing the consumer test misses.

    @Test
    public void isConfigured_is_a_promise_returning_bridge_method_taking_a_single_PluginCall() {
        Method isConfigured = declaredMethod("isConfigured");

        assertTrue(
            "isConfigured must be public; Capacitor invokes it reflectively from the bridge.",
            Modifier.isPublic(isConfigured.getModifiers())
        );
        assertEquals(
            "A Capacitor plugin method returns void and answers through the PluginCall.",
            void.class,
            isConfigured.getReturnType()
        );
        assertParametersAre(isConfigured, PluginCall.class);

        PluginMethod pluginMethod = isConfigured.getAnnotation(PluginMethod.class);
        assertNotNull(
            "isConfigured lost its @PluginMethod annotation. It still compiles and still exists, but the bridge "
                + "rejects the call at runtime, so the JS promise rejects and remote push stays off forever.",
            pluginMethod
        );
        assertEquals(
            "isConfigured is awaited in JS, so it must keep the promise return type. RETURN_CALLBACK or "
                + "RETURN_NONE would leave `await status.isConfigured()` hanging or resolving with nothing.",
            PluginMethod.RETURN_PROMISE,
            pluginMethod.returnType()
        );
    }

    /**
     * Ties the native metadata to the only file that consumes it. Nothing else in the
     * build sees both sides of this boundary, so a rename on either side is otherwise
     * a silent break.
     */
    @Test
    public void the_web_bundle_looks_the_plugin_up_under_the_same_id_and_method_name() {
        CapacitorPlugin annotation = FcmStatusPlugin.class.getAnnotation(CapacitorPlugin.class);
        assertNotNull("FcmStatusPlugin lost its @CapacitorPlugin annotation.", annotation);

        String pluginId = annotation.name();
        String methodName = declaredMethod("isConfigured").getName();
        String js = ProjectFiles.read(ProjectFiles.inRepo(JS_CONSUMER));

        assertTrue(
            JS_CONSUMER + " no longer reads Plugins?." + pluginId + " -- the native plugin id and the JS lookup "
                + "have drifted apart.",
            js.contains("Plugins?." + pluginId)
        );
        assertTrue(
            JS_CONSUMER + " no longer calls ." + methodName + "() -- the native method name and the JS call have "
                + "drifted apart.",
            js.contains("." + methodName + "()")
        );
    }

    private static Method declaredMethod(String name) {
        for (Method method : FcmStatusPlugin.class.getDeclaredMethods()) {
            if (method.getName().equals(name)) {
                return method;
            }
        }
        throw new AssertionError("FcmStatusPlugin declares no method named " + name + ".");
    }

    private static void assertParametersAre(Method method, Class<?>... expected) {
        Class<?>[] actual = method.getParameterTypes();
        assertEquals(
            "A Capacitor plugin method takes exactly one PluginCall; " + method.getName() + " takes "
                + java.util.Arrays.toString(actual),
            expected.length,
            actual.length
        );
        for (int i = 0; i < expected.length; i++) {
            assertEquals("Parameter " + i + " of " + method.getName(), expected[i], actual[i]);
        }
    }
}
