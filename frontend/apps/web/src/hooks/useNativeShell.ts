import { useEffect } from 'react';

import {
  addAppStateListener,
  addBackButtonListener,
  exitApp,
  hideSplashScreen,
  isIosPlatform,
  isNativePlatform,
  setStatusBarStyle,
  setSystemBarsBackground,
  syncNativeIntentConfig,
} from '@ci/common';
import { useNavigate } from 'react-router-dom';

/**
 * Convert a CSS `rgb()`/`rgba()` color string to `#rrggbb`. Used to feed the app's
 * real, theme-resolved background to the Android status bar so the bar matches the
 * chrome exactly. Returns undefined for any non-rgb serialization (e.g. an `oklch()`
 * the webview chose not to resolve), letting the caller fall back to a brand color.
 */
function rgbToHex(value: string): string | undefined {
  const match = value.match(/^rgba?\(([^)]+)\)/);

  if (!match) {
    return undefined;
  }

  const [r, g, b] = match[1].split(',').map((part) => part.trim());

  if (r == null || g == null || b == null) {
    return undefined;
  }

  const toByte = (channel: string) => {
    const raw = channel.endsWith('%') ? (parseFloat(channel) / 100) * 255 : parseFloat(channel);

    return Math.max(0, Math.min(255, Math.round(raw)))
      .toString(16)
      .padStart(2, '0');
  };

  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/**
 * Match the native status bar to the web app's current theme. Capacitor's `DARK` style
 * is light (white) glyphs, `LIGHT` is dark (black) glyphs — the opposite of English.
 * Dark theme → DARK (white icons), light theme → LIGHT (black icons).
 */
function applyStatusBarForTheme(): void {
  const isDark = document.documentElement.classList.contains('dark');

  let background: string | undefined;
  try {
    background = rgbToHex(getComputedStyle(document.body).backgroundColor);
  } catch {
    // getComputedStyle can throw if body isn't ready — fall back below.
  }

  const resolved = background ?? (isDark ? '#0b1f28' : '#ffffff');
  void setStatusBarStyle(isDark ? 'DARK' : 'LIGHT', resolved);
  // Android: the WebView is inset by the system bars, so the strips above and below it
  // are window background, not web content. Paint them to match (no-op elsewhere).
  void setSystemBarsBackground(resolved);
}

/**
 * Wires the React app into the native Capacitor shell. All effects are guarded by
 * `isNativePlatform()`, so this is inert on web.
 *
 * - Dismisses the native splash screen once the app has mounted.
 * - Keeps the native status bar in sync with the app's light/dark theme (and re-applies
 *   it whenever the theme changes), so glyphs stay legible on both.
 * - Handles the Android hardware back button: navigate back through history, or quit
 *   the app at the root (without this, the back button closes the app immediately —
 *   the default Capacitor behavior — which is jarring mid-navigation).
 *
 * Must be rendered inside the Router so it can navigate.
 */
export function useNativeShell(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isNativePlatform()) {
      return;
    }

    void hideSplashScreen();
    // `ci-ios` / `ci-android` let CSS tell the two shells apart: iOS is edge-to-edge
    // and pads by its own safe-area floors, Android is inset natively and must not.
    document.documentElement.classList.add('ci-native', isIosPlatform() ? 'ci-ios' : 'ci-android');

    // Mirror the API base URL into the keystore so native App Intents can reach the
    // server — now (covers the configured server from a previous session) and whenever
    // the app returns to the foreground (covers a server just set this session).
    void syncNativeIntentConfig();
    let disposeAppState = () => {};

    void addAppStateListener((isActive) => {
      if (isActive) {
        void syncNativeIntentConfig();
      }
    }).then((fn) => {
      disposeAppState = fn;
    });

    // Sync the status bar to the current theme now, then on every theme change. The
    // ThemeProvider swaps the `dark`/`light` class on <html>, so observe that attribute.
    applyStatusBarForTheme();
    const themeObserver = new MutationObserver(() => applyStatusBarForTheme());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // `addBackButtonListener` is async; if the effect cleans up before it resolves,
    // remove the listener as soon as it arrives (the `disposed` guard) so it can't
    // leak past unmount.
    let disposed = false;
    let unsubscribe = () => {};

    void addBackButtonListener((canGoBack) => {
      if (canGoBack) {
        navigate(-1);
      } else {
        void exitApp();
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unsubscribe = fn;
      }
    });

    return () => {
      disposed = true;
      themeObserver.disconnect();
      disposeAppState();
      unsubscribe();
      document.documentElement.classList.remove('ci-native', 'ci-ios', 'ci-android');
    };
  }, [navigate]);
}
