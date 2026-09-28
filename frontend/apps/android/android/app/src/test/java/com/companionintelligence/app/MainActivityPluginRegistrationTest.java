package com.companionintelligence.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import com.companionintelligence.localhub.AuthTabSession;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import java.lang.reflect.Field;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

/**
 * MainActivity's plugin registration is an ordering constraint that the language
 * cannot express:
 *
 * <pre>
 *     registerPlugin(FcmStatusPlugin.class);
 *     super.onCreate(savedInstanceState);
 * </pre>
 *
 * <p>{@code registerPlugin} only appends to {@code BridgeActivity.bridgeBuilder}, and
 * {@code BridgeActivity.onCreate} ends by calling {@code load()}, which does
 * {@code bridgeBuilder.addPlugins(initialPlugins).setConfig(config).create()}. Once
 * {@code create()} has run, the builder is never consulted again -- so swapping the two
 * statements compiles, launches, and leaves {@code window.Capacitor.Plugins.FcmStatus}
 * undefined on every device forever.
 *
 * <p>Asserting on index 0 rather than membership is what makes this a test of the
 * ordering: in the correct order FcmStatusPlugin is the first thing appended, ahead of
 * everything BridgeActivity later loads from {@code assets/capacitor.plugins.json}. In
 * the broken order it is either last or absent. {@code contains()} would pass in both.
 */
@RunWith(RobolectricTestRunner.class)
// Pinned rather than inherited from targetSdk so a compileSdk bump cannot make this test
// depend on Robolectric shipping a matching android-all image on day one.
@Config(sdk = 34)
public class MainActivityPluginRegistrationTest {

    @Test
    public void the_fcm_status_plugin_is_registered_before_the_bridge_is_built() {
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class);
        MainActivity activity = controller.get();

        Throwable bridgeBootFailure = null;
        try {
            controller.create();
        } catch (Throwable failure) {
            // Booting the whole Capacitor bridge off-device (cordova's ConfigXmlParser, a real
            // WebView provider, WebViewCompat.addDocumentStartJavaScript) is not something
            // Robolectric can do faithfully, and it is not what is under test. The registration
            // happens before any of that, so whatever the bridge did afterwards, the builder
            // state we read below is already final and still correct to assert on.
            //
            // Held rather than dropped: the swallow is only sound while onCreate still got as
            // far as registerPlugin. If it did not, the assertions below would report "no
            // plugins registered" and hide the real reason, so it is rethrown instead.
            bridgeBootFailure = failure;
        }

        List<?> registered = pluginsHandedToTheBridgeBuilder(activity);

        if (registered.isEmpty() && bridgeBootFailure != null) {
            throw new AssertionError(
                "MainActivity.onCreate registered no plugins, and the activity threw on the way there. That is a "
                    + "new failure mode rather than the known Robolectric bridge-boot limitation this test tolerates "
                    + "-- see the cause.",
                bridgeBootFailure
            );
        }

        assertFalse(
            "MainActivity.onCreate registered no plugins at all. FcmStatusPlugin is what gates Android remote "
                + "push registration; without it the web bundle can never confirm FCM is configured.",
            registered.isEmpty()
        );
        assertSame(
            "FcmStatusPlugin must be the FIRST class handed to the Bridge.Builder, i.e. registerPlugin() must run "
                + "before super.onCreate(). After super.onCreate() the Bridge has already been created from the "
                + "builder and later additions are silently ignored. Registered order was: " + registered,
            FcmStatusPlugin.class,
            registered.get(0)
        );
        assertTrue(
            "Auth Tab must be registered in onCreate before the activity starts, or sign-in falls "
                + "out to the system browser and never gets the in-app companion:// callback.",
            AuthTabSession.isRegistered()
        );
    }

    /**
     * Reaches into Capacitor's own fields, because the builder is not exposed any other way.
     * Both names are verified against the vendored source in
     * {@code node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/}; a
     * Capacitor upgrade that renames either should fail here with a sentence rather than a
     * bare NoSuchFieldException.
     */
    private static List<?> pluginsHandedToTheBridgeBuilder(MainActivity activity) {
        Object builder = read(BridgeActivity.class, "bridgeBuilder", activity);
        Object plugins = read(Bridge.Builder.class, "plugins", builder);
        return (List<?>) plugins;
    }

    private static Object read(Class<?> owner, String fieldName, Object instance) {
        try {
            Field field = owner.getDeclaredField(fieldName);
            field.setAccessible(true);
            return field.get(instance);
        } catch (NoSuchFieldException ex) {
            throw new AssertionError(
                "Capacitor no longer has " + owner.getName() + "." + fieldName + ". This test reads it to prove "
                    + "FcmStatusPlugin is registered before the Bridge is built; find the new equivalent rather "
                    + "than deleting the test -- the ordering it protects is still real.",
                ex
            );
        } catch (IllegalAccessException ex) {
            throw new AssertionError("Could not read " + owner.getName() + "." + fieldName, ex);
        }
    }
}
