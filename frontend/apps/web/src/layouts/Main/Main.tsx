import { Suspense } from 'react';

import { LoadingPage, Portal, useDeviceLayout } from '@ci/common';
import { Toaster } from '@ci/shadcn';
import { Outlet } from 'react-router-dom';

import logo from '@/assets/logo.png';

import { MobileNavigation } from './MobileNavigation/MobileNavigation';
import { PrimaryNavigation } from './PrimaryNavigation';
import { SecondaryNavigation } from './SecondaryNavigation';

export function Main() {
  const { isMobile } = useDeviceLayout();

  if (isMobile) {
    return (
      <div className="flex flex-col h-lvh">
        <Toaster position="top-right" />
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
      <div className="flex items-center justify-center py-2 px-3 bg-secondary">
        <a href="https://companionintelligence.com" target="_blank" rel="noopener noreferrer">
          <img src={logo} alt="Logo" className="h-8 w-8" />
        </a>
      </div>

      <div className="bg-secondary/20 border-b border-b-secondary/90">
        <PrimaryNavigation />
      </div>

      <div className="bg-secondary/20 border-r border-r-secondary/90">
        <SecondaryNavigation />
      </div>

      <div className="overflow-hidden min-w-0 min-h-0 flex flex-col">
        <Suspense fallback={<LoadingPage />}>
          <Toaster />
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
