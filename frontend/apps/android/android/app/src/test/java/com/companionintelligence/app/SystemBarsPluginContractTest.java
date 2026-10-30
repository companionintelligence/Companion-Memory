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
 * The SystemBars bridge contract, pinned the same way {@link FcmStatusPluginContractTest}
 * pins FcmStatus: Capacitor resolves the plugin id and the method name as strings at
 * runtime, so a drift on either side is not a compile error but a window that quietly
 * keeps the launch splash drawable behind the system bars.
 */
public class SystemBarsPluginContractTest {

    /** The one consumer: the @ci/common bridge wrapper every web caller goes through. */
    private static final String JS_CONSUMER = "frontend/packages/common/src/utils/nativeBridge.ts";

    @Test
    public void setBackgroundColor_is_a_promise_returning_bridge_method_taking_a_single_PluginCall() {
        Method method = declaredMethod("setBackgroundColor");

        assertTrue("setBackgroundColor must be public; Capacitor invokes it reflectively.", Modifier.isPublic(method.getModifiers()));
        assertEquals("A Capacitor plugin method returns void and answers through the PluginCall.", void.class, method.getReturnType());
        assertEquals("A Capacitor plugin method takes exactly one PluginCall.", 1, method.getParameterTypes().length);
        assertEquals(PluginCall.class, method.getParameterTypes()[0]);

        PluginMethod pluginMethod = method.getAnnotation(PluginMethod.class);
        assertNotNull("setBackgroundColor lost its @PluginMethod annotation; the bridge would reject the call.", pluginMethod);
        assertEquals("setBackgroundColor is awaited in JS.", PluginMethod.RETURN_PROMISE, pluginMethod.returnType());
    }

    @Test
    public void the_web_bundle_looks_the_plugin_up_under_the_same_id_and_method_name() {
        CapacitorPlugin annotation = SystemBarsPlugin.class.getAnnotation(CapacitorPlugin.class);
        assertNotNull("SystemBarsPlugin lost its @CapacitorPlugin annotation.", annotation);

        String pluginId = annotation.name();
        String methodName = declaredMethod("setBackgroundColor").getName();
        String js = ProjectFiles.read(ProjectFiles.inRepo(JS_CONSUMER));

        assertTrue(JS_CONSUMER + " no longer reads ?." + pluginId + " -- the plugin id and the JS lookup have drifted apart.", js.contains("?." + pluginId));
        assertTrue(JS_CONSUMER + " no longer calls ." + methodName + "( -- the method name and the JS call have drifted apart.", js.contains("." + methodName + "("));
    }

    private static Method declaredMethod(String name) {
        for (Method method : SystemBarsPlugin.class.getDeclaredMethods()) {
            if (method.getName().equals(name)) {
                return method;
            }
        }
        throw new AssertionError("SystemBarsPlugin declares no method named " + name + ".");
    }
}
