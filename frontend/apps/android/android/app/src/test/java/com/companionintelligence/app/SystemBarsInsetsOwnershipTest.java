package com.companionintelligence.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.Test;

/**
 * Two settings in capacitor.config.ts that no compiler and no other test sees, each of which broke
 * the edge-to-edge behaviour on Android 15+ when Capacitor 8 arrived. Both were found on an emulator,
 * with the measurements below, and both are one-line switches that a config tidy-up could undo.
 *
 * <p><b>Who insets the WebView: {@link WebViewInsets}, and nothing else.</b> Capacitor 8 ships a core
 * {@code SystemBars} plugin that, by default ({@code insetsHandling: 'css'}), installs a window-insets
 * listener on the decor view. It pads the whole window by the system bars <em>and by the keyboard</em>
 * while {@link WebViewInsets} margins the WebView by the same amounts. The keyboard inset was applied
 * twice: on a 1080x2400 emulator with the keyboard up the WebView was 571 px tall where about 1450 px
 * lay between the status bar and the keyboard, and the page showed a blank band above the keyboard.
 * The listener's padding is also the only thing insetting the window, and
 * {@link SystemBarsPlugin#paint} resets it ({@code Window.setBackgroundDrawable} ends in
 * {@code DecorView.drawableChanged}, which sets the decor padding back to zero), so the page could
 * be left under the status bar and the navigation bar until the next insets pass. The app's own
 * plugin has the same id as the core one, so the bridge's handle for "SystemBars" is ours; that does
 * not stop the core one, because building a plugin runs its {@code load()}, which installs the
 * listener, before the app's plugin replaces its handle. The one switch that stops it is the plugin's
 * own config.
 *
 * <p><b>No exit-animation listener on the launch splash.</b> With the default
 * {@code launchFadeOutDuration} of 200 the splash plugin registers one, and androidx.core.splashscreen
 * then re-applies the theme's system-bar appearance when it hands the splash over
 * ({@code SplashScreen$Impl31.applyAppSystemUiTheme}). The plugin holds the first frame until the web
 * app calls {@code SplashScreen.hide()}, so that always lands after the web layer's one status-bar
 * sync, and the theme has no {@code windowLightStatusBar}: on a light page the status and navigation
 * bar icons went white, with a contrast of 1.06:1, until the next theme change.
 */
public class SystemBarsInsetsOwnershipTest {

    private static final String CONFIG = "frontend/apps/android/capacitor.config.ts";

    @Test
    public void the_app_plugin_has_the_same_id_as_capacitors_core_SystemBars_plugin() {
        assertEquals(
            "The app's SystemBarsPlugin and Capacitor's core SystemBars plugin no longer share an id. The core "
                + "plugin is then registered beside the app's one instead of being replaced by it, and its "
                + "lifecycle hooks start running too: re-check capacitor.config.ts (SystemBars.insetsHandling) "
                + "and WebViewInsets before deleting this test.",
            pluginId(com.getcapacitor.plugin.SystemBars.class),
            pluginId(SystemBarsPlugin.class)
        );
    }

    @Test
    public void capacitors_own_inset_handling_is_switched_off_so_WebViewInsets_is_the_only_one() {
        String systemBars = pluginBlock(config(), "SystemBars");

        assertNotNull(
            CONFIG + " has no plugins.SystemBars block. Without `insetsHandling: 'disable'` Capacitor's core "
                + "SystemBars plugin pads the window for the keyboard as well as WebViewInsets doing it, so the "
                + "page shrinks by twice the keyboard height.",
            systemBars
        );
        assertTrue(
            CONFIG + " must set plugins.SystemBars.insetsHandling to 'disable'; found: " + systemBars,
            Pattern.compile("insetsHandling\\s*:\\s*['\"]disable['\"]").matcher(systemBars).find()
        );
    }

    @Test
    public void the_launch_splash_registers_no_exit_animation_listener_that_would_reset_the_status_bar_icons() {
        String splash = pluginBlock(config(), "SplashScreen");

        assertNotNull(CONFIG + " has no plugins.SplashScreen block.", splash);
        assertTrue(
            CONFIG + " must set plugins.SplashScreen.launchFadeOutDuration to 0. Any positive value registers the "
                + "exit-animation listener whose hand-over resets the status and navigation bar icons to white "
                + "after the web layer has set them; found: " + splash,
            Pattern.compile("launchFadeOutDuration\\s*:\\s*0\\s*[,}\\n]").matcher(splash + "\n").find()
        );
    }

    @Test
    public void the_config_reader_ignores_a_commented_out_setting_and_finds_nested_blocks() {
        String config =
            "plugins: {\n  // SystemBars: { insetsHandling: 'disable' },\n  /* SplashScreen: { launchFadeOutDuration: 0 }, */\n"
                + "  Other: { a: 1, nested: { b: 2 } },\n}";

        assertNull(pluginBlock(stripComments(config), "SystemBars"));
        assertNull(pluginBlock(stripComments(config), "SplashScreen"));
        assertEquals(" a: 1, nested: { b: 2 } ", pluginBlock(stripComments(config), "Other"));
    }

    private static String config() {
        return stripComments(ProjectFiles.read(ProjectFiles.inRepo(CONFIG)));
    }

    /** The id Capacitor registers a plugin under: the annotation's name, else the simple class name. */
    private static String pluginId(Class<?> plugin) {
        CapacitorPlugin annotation = plugin.getAnnotation(CapacitorPlugin.class);

        return annotation != null && !annotation.name().isEmpty() ? annotation.name() : plugin.getSimpleName();
    }

    /** The body of {@code <name>: { ... }} in a config with its comments removed, or null. */
    static String pluginBlock(String config, String name) {
        Matcher open = Pattern.compile("\\b" + Pattern.quote(name) + "\\s*:\\s*\\{").matcher(config);
        if (!open.find()) {
            return null;
        }
        int depth = 1;
        int start = open.end();
        for (int i = start; i < config.length(); i++) {
            char c = config.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                return config.substring(start, i);
            }
        }
        return null;
    }

    static String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
    }
}
