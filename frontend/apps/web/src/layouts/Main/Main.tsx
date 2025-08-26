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

            <div className="flex flex-col h-screen">
              <PrimaryNavigation />

              <div className="flex flex-row flex-1 min-h-0">
                <Portal id="tertiary-navigation" className="h-full" />

                <main className="flex-1 min-w-0">
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
