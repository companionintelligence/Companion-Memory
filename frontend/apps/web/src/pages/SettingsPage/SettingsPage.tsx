import { lazy, Suspense, useCallback, useEffect } from 'react';

import { LoadingPage, Portal, usePageTitle } from '@ci/common';
import { Button, ScrollArea } from '@ci/shadcn';
import { Braces, ExternalLink, Globe, Key, KeyRound, Palette, X } from '@ci/shadcn/icons';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

const AppearanceSection = lazy(() =>
  import('./sections/AppearanceSection').then((m) => ({ default: m.AppearanceSection })),
);
const PreferencesSection = lazy(() =>
  import('./sections/PreferencesSection').then((m) => ({ default: m.PreferencesSection })),
);
const ApiKeysSection = lazy(() =>
  import('./sections/ApiKeysSection').then((m) => ({ default: m.ApiKeysSection })),
);
const OAuthSection = lazy(() => import('./sections/OAuthSection').then((m) => ({ default: m.OAuthSection })));

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors w-full text-left whitespace-nowrap',
    isActive
      ? 'bg-accent text-accent-foreground font-medium'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
  ].join(' ');

export function SettingsPage() {
  usePageTitle('Settings - Companion Intelligence');

  const location = useLocation();
  const navigate = useNavigate();
  const backgroundLocation = (
    location.state as { backgroundLocation?: { pathname: string; search: string; hash: string } } | null
  )?.backgroundLocation;

  const handleClose = useCallback(() => {
    navigate(backgroundLocation ?? '/feed');
  }, [backgroundLocation, navigate]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleClose]);

  return (
    <Portal.Slot id="overlay-modal">
      <div
        className="flex h-full bg-black/70 backdrop-blur-[2px] items-center justify-center"
        onClick={handleClose}
      >
        <div
          className="flex w-full max-w-6xl mx-8 h-[calc(100%-4rem)] rounded-xl overflow-hidden shadow-2xl border border-border bg-background relative"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            aria-label="Close Settings"
            className="absolute top-3 right-3 z-10"
          >
            <X className="h-4 w-4" />
          </Button>

          <ScrollArea className="w-60 flex-shrink-0 border-r border-border">
            <aside className="flex flex-col gap-1 p-4">
              <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Settings
              </p>

              <NavLink to="/settings/appearance" state={{ backgroundLocation }} className={navLinkClass}>
                <Palette className="h-4 w-4" />
                Appearance
              </NavLink>

              <NavLink to="/settings/preferences" state={{ backgroundLocation }} className={navLinkClass}>
                <Globe className="h-4 w-4" />
                Preferences
              </NavLink>

              <NavLink to="/settings/api-keys" state={{ backgroundLocation }} className={navLinkClass}>
                <KeyRound className="h-4 w-4" />
                API Keys
              </NavLink>

              <NavLink to="/settings/oauth" state={{ backgroundLocation }} className={navLinkClass}>
                <Key className="h-4 w-4" />
                OAuth Credentials
              </NavLink>

              {/* GraphiQL is a full-page IDE served by the API, so it opens in a
                  new tab rather than inside the settings modal. Authenticate it
                  with a key from the API Keys section above. */}
              <a
                href="/api/graphiql"
                target="_blank"
                rel="noopener noreferrer"
                className={navLinkClass({ isActive: false })}
              >
                <Braces className="h-4 w-4" />
                GraphiQL
                <ExternalLink className="ml-auto h-3.5 w-3.5 opacity-60" />
              </a>
            </aside>
          </ScrollArea>

          {/* Content */}
          <ScrollArea className="flex-1">
            <main>
              <div className="mx-auto max-w-2xl p-6">
                <Suspense fallback={<LoadingPage />}>
                  <Routes>
                    <Route index element={<Navigate to="appearance" replace />} />
                    <Route path="appearance" element={<AppearanceSection />} />
                    <Route path="preferences" element={<PreferencesSection />} />
                    <Route path="api-keys" element={<ApiKeysSection />} />
                    <Route path="oauth" element={<OAuthSection />} />
                  </Routes>
                </Suspense>
              </div>
            </main>
          </ScrollArea>
        </div>
      </div>
    </Portal.Slot>
  );
}
