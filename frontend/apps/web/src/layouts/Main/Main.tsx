import { Suspense } from 'react';

import { LoadingPage, Portal } from '@ci/common';
import { Sidebar, Toaster } from '@ci/shadcn';
import { Outlet } from 'react-router-dom';

import { useDeviceLayout } from '@/hooks';

import { PrimaryNavigation } from './PrimaryNavigation';
import { SecondaryNavigation } from './SecondaryNavigation';

export function Main() {
  const { isMobile } = useDeviceLayout();

  return (
    <>
      <Sidebar.Provider>
        <SecondaryNavigation />

        <Sidebar.Inset className="overflow-hidden">
          <Suspense fallback={<LoadingPage />}>
            <Toaster />

            <div className="flex flex-col h-screen">
              <PrimaryNavigation />

              <div className="flex flex-row flex-1 min-h-0">
                <Portal
                  id="tertiary-navigation"
                  className={`h-full transition-all duration-300 ${isMobile ? 'hidden' : ''}`}
                />

                <main className="flex-1 min-w-0 transition-all duration-300">
                  <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <Outlet />
                  </div>
                </main>
              </div>
            </div>
          </Suspense>
        </Sidebar.Inset>
      </Sidebar.Provider>
    </>
  );
}
