import { Suspense } from 'react';

import { LoadingPage, Portal, useDeviceLayout } from '@ci/common';
import { Toaster, Tooltip } from '@ci/shadcn';
import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';

import logo from '@/assets/logo.png';
import { ConnectionModeIndicator, OutboxQueueIndicator } from '@/components/ConnectionModeIndicator';
import { useTheme } from '@/components/ThemePicker';

import { MobileNavigation } from './MobileNavigation/MobileNavigation';
import { PrimaryNavigation } from './PrimaryNavigation';
import { SecondaryNavigation } from './SecondaryNavigation';

export function Main() {
  const { t } = useTranslation();
  const { isMobile } = useDeviceLayout();
  const { themeState } = useTheme();

  if (isMobile) {
    return (
      <div className="flex flex-col h-lvh">
        <Toaster position="top-right" theme={themeState.mode} />
        <div className="fixed top-2 right-2 z-40 flex items-center gap-1.5">
          <ConnectionModeIndicator />
          <OutboxQueueIndicator />
        </div>
        <main className="flex-1 min-w-0 overflow-hidden min-h-0 relative">
          <Suspense fallback={<LoadingPage />}>
            <Outlet />
            <Portal id="content-modal" className="absolute inset-0 empty:hidden" />
          </Suspense>
        </main>
        <MobileNavigation />
        <Portal id="overlay-modal" className="fixed inset-0 z-50 empty:hidden" />
      </div>
    );
  }

  return (
    <div className="grid h-lvh min-h-0 grid-cols-[auto_1fr] grid-rows-[auto_1fr]">
      <div className="fixed top-2 right-2 z-40 flex items-center gap-1.5">
        <ConnectionModeIndicator />
        <OutboxQueueIndicator />
      </div>

      <div className="flex items-center justify-center py-2 px-3 bg-secondary">
        <Tooltip delayDuration={600}>
          <Tooltip.Content>{t('NAV_LOGO_EXTERNAL')}</Tooltip.Content>
          <Tooltip.Trigger asChild>
            <a
              href="https://companionintelligence.com"
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('NAV_LOGO_EXTERNAL')}
            >
              <img src={logo} alt="Logo" className="h-8 w-8" />
            </a>
          </Tooltip.Trigger>
        </Tooltip>
      </div>

      <div className="bg-secondary/20 border-b border-b-secondary/90">
        <PrimaryNavigation />
      </div>

      <div className="bg-secondary/20 border-r border-r-secondary/90">
        <SecondaryNavigation />
      </div>

      <div className="overflow-hidden min-w-0 min-h-0 flex flex-col">
        <Suspense fallback={<LoadingPage />}>
          <Toaster theme={themeState.mode} />
          <div className="flex flex-row h-full min-h-0">
            <Portal id="tertiary-navigation" className="h-full" />
            <main className="flex-1 min-w-0 relative">
              <Outlet />
              <Portal id="content-modal" className="absolute inset-0 empty:hidden" />
            </main>
          </div>
        </Suspense>
      </div>
      <Portal id="overlay-modal" className="fixed inset-0 z-50 empty:hidden" />
    </div>
  );
}
