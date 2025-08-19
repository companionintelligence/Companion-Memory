import { Suspense } from 'react';

import { LoadingPage, Portal } from '@ci/common';
import { Sidebar, Toaster, cn } from '@ci/shadcn';
import { Outlet } from 'react-router-dom';

import { PrimaryNavigation } from './PrimaryNavigation';
import { SecondaryNavigation } from './SecondaryNavigation';

interface Props {
  contentPadding?: boolean;
  delegateScrolling?: boolean;
}

export function Main({ contentPadding = true, delegateScrolling = false }: Props) {
  return (
    <>
      <Sidebar.Provider>
        <SecondaryNavigation />

        <Sidebar.Inset>
          <Suspense fallback={<LoadingPage />}>
            <Toaster />

            <div className="flex flex-col h-screen">
              <PrimaryNavigation />

              <div className="flex flex-row flex-1 min-h-0">
                <aside className="flex flex-col">
                  <Portal
                    id="tertiary-navigation"
                    className="flex flex-col flex-1 h-full min-h-0 overflow-hidden"
                  />
                </aside>

                <main
                  className={cn(
                    'flex flex-1 h-full min-h-0',
                    delegateScrolling ? 'overflow-hidden' : 'overflow-y-auto',
                    contentPadding ? 'p-4' : '',
                  )}
                >
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
