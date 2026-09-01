import { StrictMode } from 'react';

import { initApiBaseUrl } from '@ci/common';
import { createRoot } from 'react-dom/client';

import './styles/index.css';
import App from './App.tsx';
import { initI18n } from './lib/i18n';
import { initTelemetry } from './lib/telemetry';

// Bundled and synchronous, so `t()` resolves during the very first render.
initI18n();

// Resolve the API origin before anything renders. No-op on web (stays same-origin);
// on the native Capacitor shell this loads the user-configured server URL so Apollo
// and the auth/fetch layer target the right host from the first request.
//
// MUST stay ahead of `initTelemetry()`. That call reaches the appliance to check
// consent, and it issues its fetch synchronously — before its first `await` ever
// yields — so an origin resolved after it would arrive too late to be used. In
// the other order the consent probe on native requests a relative path against
// `capacitor://localhost`, fails, and (because it fails closed) silently
// disables error reporting for the entire mobile app.
initApiBaseUrl();

// No-op unless VITE_SENTRY_DSN was baked in at build time AND the appliance
// confirms the user has consented. Deliberately not awaited: reporting must
// never delay first render.
void initTelemetry();

// Facebook OAuth appends #_=_ to redirect URLs; it can break React Router and cause blank screens.
// Clear it as early as possible so routing works correctly.
if (typeof window !== 'undefined' && window.location.hash === '#_=_') {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

// Dev never registers the PWA service worker (`devOptions.enabled: false`),
// but a worker installed by an earlier production/preview build on the same
// origin persists and keeps intercepting `/api/*`. A response streaming
// through a service worker dies when the browser terminates the idle worker
// (~30s in Chrome), so every chat turn on a dev origin with a stale worker
// collapsed mid-stream with "TypeError: network error". Evict them here; the
// current page stays controlled until its next reload, so the second load
// after this ships is the clean one.
if (import.meta.env.DEV && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      for (const registration of registrations) {
        void registration.unregister();
      }
    })
    .catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
