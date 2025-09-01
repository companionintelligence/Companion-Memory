import { Suspense } from 'react';

import { LoadingPage, Portal } from '@ci/common';
import { Sidebar, Toaster } from '@ci/shadcn';
import { Outlet } from 'react-router-dom';

import { PrimaryNavigation } from './PrimaryNavigation';
import { SecondaryNavigation } from './SecondaryNavigation';

export function Main() {
  return (
    <>
      <Sidebar.Provider>
        <SecondaryNavigation />

        <Sidebar.Inset className="overflow-hidden">
          <Suspense fallback={<LoadingPage />}>
            <Toaster />

            <div className="flex flex-col h-screen ios-safe-area-top ios-safe-area-bottom">
              <PrimaryNavigation />

              <div className="flex flex-row flex-1 min-h-0">
                <Portal id="tertiary-navigation" className="h-full" />

                <main className="flex-1 min-w-0 smooth-scroll ios-safe-area-left ios-safe-area-right">
                  <Outlet />
                </main>
              </div>
            </div>
          </Suspense>
        </Sidebar.Inset>
      </Sidebar.Provider>
    </>
  );
}
