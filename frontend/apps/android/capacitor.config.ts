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
    // Required by @capacitor-community/background-geolocation: without it, location
    // updates delivered through the legacy Capacitor bridge stop after ~5 minutes in
    // the background. See https://github.com/capacitor-community/background-geolocation/issues/89.
    useLegacyBridge: true,
    // Deliberately NOT `adjustMarginsForEdgeToEdge: 'auto'`. Android 15+ lays the window
    // out edge-to-edge and the WebView needs insetting from the system bars (three-button
    // navigation otherwise covers the bottom ~48 dp of every page), but Capacitor's version
    // consumes the keyboard inset without applying it, which left the chat composer behind
    // the keyboard. MainActivity attaches WebViewInsets instead: bars AND keyboard.
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#ffffff',
      showSpinner: false,
      androidSplashResourceName: 'splash',
      splashFullScreen: true,
      splashImmersive: false,
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
  },
};

export default config;
