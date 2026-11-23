import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the Android shell. The app ships the @ci/fe-web Vite build
 * (webDir → ../web/dist); build it with the PWA service worker disabled
 * (VITE_DISABLE_PWA=true) so Workbox doesn't fight Capacitor's local asset serving.
 *
 * First launch with no server origin routes to `/device-connect` (Portal picker).
 * `/server` remains the Advanced URL fallback. Do not reuse `/connect` — that is Sources.
 */
const config: CapacitorConfig = {
  appId: 'com.ci.memory',
  appName: 'Companion Memory',
  webDir: '../web/dist',
  server: {
    androidScheme: 'https',
    ...(process.env.CAP_SERVER_URL ? { url: process.env.CAP_SERVER_URL, cleartext: true } : {}),
  },
  android: {
    allowMixedContent: true,
    // Pinch-zoom. It defaults to false, and then Bridge.java calls
    // WebSettings.setBuiltInZoomControls(false), which turns the pinch gesture off whatever the
    // page's viewport meta says. It is the only in-app way to enlarge the app (one input to
    // WCAG 1.4.4, not all of it). scripts/check-viewport-zoom.mjs fails if this goes away.
    zoomEnabled: true,
    // Deliberately NOT `adjustMarginsForEdgeToEdge: 'auto'` (Capacitor 7; Capacitor 8 replaced it
    // with the SystemBars plugin below). Android 15+ lays the window out edge-to-edge and the
    // WebView needs insetting from the system bars (three-button navigation otherwise covers the
    // bottom ~48 dp of every page), but Capacitor's version consumes the keyboard inset without
    // applying it, which left the chat composer behind the keyboard. MainActivity attaches
    // WebViewInsets instead: bars AND keyboard.
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#ffffff',
      showSpinner: false,
      androidSplashResourceName: 'splash',
      splashFullScreen: true,
      splashImmersive: false,
      // 0 = register no exit-animation listener for the Android 12+ launch splash. With one (the
      // default, 200 ms) androidx.core.splashscreen re-applies the theme's system-bar appearance
      // when it hands the splash over (SplashScreen$Impl31.applyAppSystemUiTheme), and this plugin
      // holds the first frame until the web app calls SplashScreen.hide(), so that hand-over always
      // lands AFTER the web layer's one status-bar sync. The theme has no windowLightStatusBar, so
      // the status and navigation bar icons were reset to white, unreadable on a light page, until
      // the next theme change. SystemBarsInsetsOwnershipTest pins this value.
      launchFadeOutDuration: 0,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#ffffff',
      overlaysWebView: false,
    },
    CapacitorSQLite: {
      // The PowerSync replica (frontend/apps/web/src/api/powersync/nativeDatabase.ts)
      // opens its file with SQLCipher through this plugin. Off, every encrypted
      // call fails with "No Encryption set in capacitor.config". The key lives in
      // the plugin's EncryptedSharedPreferences, wrapped by an AndroidKeyStore key.
      androidIsEncryption: true,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    // Capacitor 8's core SystemBars plugin shares its id with this app's SystemBarsPlugin, which
    // replaces its handle but not the instance: building it already installed a window-insets
    // listener on the decor view that pads the whole window by the system bars AND the keyboard,
    // while WebViewInsets margins the WebView by the same amounts. The keyboard was applied twice
    // (the WebView was about 570 px tall on a 1080x2400 screen with the keyboard up, with a blank
    // band above the keyboard), and SystemBarsPlugin.paint() resetting the decor padding left the
    // window un-inset until the next insets pass. WebViewInsets is the only thing that insets the
    // WebView. SystemBarsInsetsOwnershipTest pins this value.
    SystemBars: {
      insetsHandling: 'disable',
    },
  },
};

export default config;
