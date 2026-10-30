package com.companionintelligence.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.Window;
import androidx.core.graphics.ColorUtils;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Paints the strips the WebView no longer covers.
 *
 * <p>Android 15 lays every window out edge-to-edge and, from targetSdk 36, no longer lets
 * an app opt out. The WebView therefore sat under the navigation bar, and with
 * three-button navigation the bottom ~48 dp of every page was behind Back / Home / Recents
 * and could not be tapped. {@link WebViewInsets} now insets the WebView by the system bars
 * instead, which leaves two strips -- status bar
 * above, navigation bar below -- showing whatever the <em>window</em> background is. Left
 * alone that is the launch theme's splash drawable, not the app's theme.
 *
 * <p>So the web side hands over its resolved body colour (the same value it already gives
 * the status bar) and this paints the window with it, and flips the navigation-bar icons
 * to dark-on-light or light-on-dark to match. {@code Window.setStatusBarColor} /
 * {@code setNavigationBarColor} are no-ops under edge-to-edge, which is why the window
 * background is what gets painted; the navigation-bar colour is still set below 35, where
 * the window is not edge-to-edge and the bar draws its own background.
 */
@CapacitorPlugin(name = "SystemBars")
public class SystemBarsPlugin extends Plugin {

    @PluginMethod
    public void setBackgroundColor(PluginCall call) {
        String raw = call.getString("color");
        final int color;
        try {
            color = Color.parseColor(raw);
        } catch (IllegalArgumentException | NullPointerException e) {
            call.reject("color must be a #rrggbb string, got " + raw);
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("no activity");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            paint(activity.getWindow(), color);
            call.resolve();
        });
    }

    @SuppressWarnings("deprecation")
    static void paint(Window window, int color) {
        window.setBackgroundDrawable(new ColorDrawable(color));
        boolean lightBackground = ColorUtils.calculateLuminance(color) > 0.5;
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightNavigationBars(lightBackground);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            window.setNavigationBarColor(color);
        }
    }
}
