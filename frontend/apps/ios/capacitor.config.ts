import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the iOS shell. The app ships the @ci/fe-web Vite build
 * (webDir → ../web/dist); build it with the PWA service worker disabled
 * (VITE_DISABLE_PWA=true) so Workbox doesn't fight Capacitor's local asset serving.
 *
 * First launch with no server origin routes to `/device-connect` (Portal picker).
 * `/server` remains the Advanced URL fallback. Do not reuse `/connect` — that is Sources.
 */
const config: CapacitorConfig = {
  appId: 'com.companionintelligence.app',
  appName: 'Memory',
  webDir: '../web/dist',
  server: {
    ...(process.env.CAP_SERVER_URL ? { url: process.env.CAP_SERVER_URL, cleartext: true } : {}),
  },
  plugins: {
    // Patch window.fetch / XHR onto URLSession. WKWebView fetch is CORS-bound;
    // Memory (core3) answers /api/health without Access-Control-Allow-Origin, which
    // the webview reports as TypeError "Load failed".
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#ffffff',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: false,
    },
    StatusBar: {
      // Capacitor LIGHT = dark glyphs. Launch splash is white, so icons must be black.
      style: 'LIGHT',
      backgroundColor: '#ffffff',
      // Edge-to-edge so `env(safe-area-inset-*)` is non-zero. CSS `.safe-area-inset`
      // then pads the notch / home indicator the way Hub does on iOS.
      overlaysWebView: true,
    },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/LocalDatabase',
      // The PowerSync replica (frontend/apps/web/src/api/powersync/nativeDatabase.ts)
      // opens its file with SQLCipher through this plugin; off, every encrypted
      // call fails with "No Encryption set in capacitor.config". The plugin
      // refuses an empty keychain prefix, and ships none.
      iosIsEncryption: true,
      iosKeychainPrefix: 'ci-memory',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
