package com.companionintelligence.app;

import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * Keeps the WebView out from under the system bars and the keyboard.
 *
 * <p>Android 15 lays every window out edge-to-edge and, from targetSdk 36, no longer lets
 * an app opt out. Left alone the WebView extends under the navigation bar, and with
 * three-button navigation the bottom ~48 dp of every page -- the chat composer, for one --
 * sits behind Back / Home / Recents and cannot be tapped. This listener gives the WebView
 * a margin equal to each system bar (and display cutout) instead, so the page ends where
 * the bars begin; the strips that exposes are painted by {@link SystemBarsPlugin}.
 *
 * <p>Why not Capacitor's own {@code adjustMarginsForEdgeToEdge}: it does the same for the
 * bars but consumes the IME inset without applying it, and once the insets are consumed
 * nothing else resizes the window for the keyboard. On a device that left the composer
 * hidden behind the keyboard, where before the change the window shrank around it. So the
 * bottom margin here is the larger of the navigation bar and the keyboard, which restores
 * the resize: the page's own viewport-height bookkeeping ({@code --vv-height}) then sees the
 * smaller WebView exactly as it saw the smaller window before.
 *
 * <p>Only wired on Android 15+. Below that the window is not edge-to-edge, the decor view
 * already fits the system windows, and {@code adjustResize} still resizes for the keyboard.
 */
final class WebViewInsets {
    private WebViewInsets() {}

    static void attach(View webView) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            return;
        }
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            Insets margins = margins(bars, ime);
            ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
            if (params.leftMargin != margins.left || params.topMargin != margins.top
                || params.rightMargin != margins.right || params.bottomMargin != margins.bottom) {
                params.setMargins(margins.left, margins.top, margins.right, margins.bottom);
                view.setLayoutParams(params);
            }
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(webView);
    }

    /** The margin on each side: the bars, except at the bottom where the keyboard may be taller. */
    static Insets margins(Insets bars, Insets ime) {
        return Insets.of(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
    }
}
