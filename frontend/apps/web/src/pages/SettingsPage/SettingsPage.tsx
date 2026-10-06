import { useCallback, useEffect } from 'react';

import { Portal, buildApiUrl, useDeviceLayout, usePageTitle } from '@ci/common';
import { IconButton, ScrollArea } from '@ci/shadcn';
import { Braces, ExternalLink, X } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';
import { NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { appHomePath } from '@/lib/appHome';

import { settingsPathToProfile, visibleSettingsSections } from './settingsNav';
import { SettingsSectionBody } from './SettingsSections';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors w-full text-left whitespace-nowrap',
    isActive
      ? 'bg-accent text-accent-foreground font-medium'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
  ].join(' ');

export function SettingsPage() {
  usePageTitle('Settings - Companion Memory');

  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { isMobile } = useDeviceLayout();
  const { isFeatureEnabled } = useFeatures();
  const backgroundLocation = (
    location.state as { backgroundLocation?: { pathname: string; search: string; hash: string } } | null
  )?.backgroundLocation;

  const handleClose = useCallback(() => {
    navigate(backgroundLocation ?? appHomePath());
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

  if (isMobile == null) {
    return null;
  }

  if (isMobile) {
    return <Navigate to={settingsPathToProfile(location.pathname)} replace />;
  }

  return (
    <Portal.Slot id="overlay-modal">
      <div
        className="pointer-events-auto flex h-full bg-black/70 backdrop-blur-[2px] items-center justify-center"
        onClick={handleClose}
      >
        <div
          className="flex w-full max-w-6xl mx-8 h-[calc(100%-4rem)] rounded-xl overflow-hidden shadow-2xl border border-border bg-background relative"
          onClick={(e) => e.stopPropagation()}
        >
          <IconButton
            variant="ghost"
            onClick={handleClose}
            label={t('SETTINGS_CLOSE')}
            tooltip={t('SETTINGS_CLOSE_HINT')}
            className="absolute top-3 right-3 z-10"
          >
            <X className="h-4 w-4" />
          </IconButton>

          <ScrollArea className="w-60 flex-shrink-0 border-r border-border">
            <aside className="flex flex-col gap-1 p-4">
              <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Settings
              </p>

              {visibleSettingsSections().map((section) => {
                const Icon = section.icon;

                return (
                  <NavLink
                    key={section.id}
                    to={`/settings/${section.id}`}
                    state={{ backgroundLocation }}
                    className={navLinkClass}
                  >
                    <Icon className="h-4 w-4" />
                    {section.label}
                  </NavLink>
                );
              })}

              {/* GraphiQL is a full-page IDE served by the API, so it opens in a
                  new tab rather than inside the settings modal. Authenticate it
                  with a key from the API Keys section above. The API serves it
                  only when `graphql.ide` is on (off in production by default),
                  so the link follows the flag rather than pointing at a 404. */}
              {isFeatureEnabled('graphql.ide') ? (
                <a
                  href={buildApiUrl('/api/graphiql')}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={navLinkClass({ isActive: false })}
                >
                  <Braces className="h-4 w-4" />
                  GraphiQL
                  <ExternalLink className="ml-auto h-3.5 w-3.5 opacity-60" />
                </a>
              ) : null}
            </aside>
          </ScrollArea>

          <ScrollArea className="flex-1">
            <main>
              <div className="mx-auto max-w-2xl p-6">
                <SettingsSectionBody
                  section={location.pathname.split('/').pop() || 'appearance'}
                  fallbackTo="/settings/appearance"
                />
              </div>
            </main>
          </ScrollArea>
        </div>
      </div>
    </Portal.Slot>
  );
}
