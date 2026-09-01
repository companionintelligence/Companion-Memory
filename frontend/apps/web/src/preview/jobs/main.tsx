/**
 * The Jobs page, mounted against fixtures instead of an appliance.
 *
 * Entry for `vite.preview.config.ts` (the `jobs-preview` configuration in
 * `.claude/launch.json`). Everything below the providers is the real page —
 * this file supplies only what `MainLayout` and `App` would have supplied, and
 * `previewApi.ts` answers the network.
 *
 * The provider list is deliberately the SHORTEST one that mounts the page, not
 * a copy of `App.tsx`'s:
 *
 *   - `BrowserRouter` — `useAuth` navigates, and `useLocation` gates its error
 *     clearing.
 *   - `ThemeProvider`  — puts the theme class on <html>; without it every
 *     shadcn colour token falls back and the page previews the wrong palette.
 *   - `DeviceLayoutProvider` — `usePhone()` drives the fold, the page size and
 *     the import card's cap. Resize the window and the phone chrome appears.
 *   - `AuthProvider` — the page's five requests gate on `authenticated`, so a
 *     preview without it sits on skeletons forever. It is the REAL provider:
 *     the fixture server answers `/authenticate/refresh` with a decodable JWT,
 *     which leaves `useJobsAuth` in the path rather than stubbed out.
 *
 * Apollo, PowerSync, Features, Model, Capture and the outbox are all absent
 * because nothing in this page's tree reaches them.
 */

import { StrictMode } from 'react';

import { DeviceLayoutProvider, initApiBaseUrl } from '@ci/common';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import '@/styles/index.css';
import { ThemeProvider } from '@/components/ThemePicker';
import { AuthProvider } from '@/hooks';
import { initI18n } from '@/lib/i18n';
import { JobsPage } from '@/pages/JobsPage/JobsPage';

initI18n();
initApiBaseUrl();

/**
 * Says out loud that none of this is real.
 *
 * The page is convincing — that is the point of fixtures drawn from a real
 * appliance — and a screenshot of it is indistinguishable from a screenshot of
 * production unless something on the page says otherwise.
 */
function FixtureBanner() {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
      <span className="font-medium">Fixture preview</span>
      <span className="opacity-80">
        No appliance, no database — every response comes from src/preview/jobs/fixtures.ts.
      </span>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
        <DeviceLayoutProvider args={[]}>
          <AuthProvider args={[]}>
            <div className="flex h-screen w-screen flex-col overflow-hidden">
              <FixtureBanner />
              <div className="min-h-0 flex-1">
                <JobsPage />
              </div>
            </div>
          </AuthProvider>
        </DeviceLayoutProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
