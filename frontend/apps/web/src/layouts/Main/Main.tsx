import { Suspense } from 'react';

import { LoadingPage, Portal, useDeviceLayout } from '@ci/common';
import { Toaster } from '@ci/shadcn';
import { Outlet } from 'react-router-dom';

import { AnimatedBackground } from '@/components/AnimatedBackground';
import { useBackground, useTheme } from '@/components/ThemePicker';
import { useUnsyncedImportsNotice } from '@/components/UnsyncedImports/useUnsyncedImportsNotice';

import { MobileNavigation } from './MobileNavigation/MobileNavigation';
import { MobileTopBar } from './MobileNavigation/MobileTopBar';
import { PowerRailProvider } from './PowerRailContext';
import { PowerRailToggle } from './PowerRailToggle';
import { PrimaryNavigation } from './PrimaryNavigation';
import { SecondaryNavigation } from './SecondaryNavigation';

export function Main() {
  const { isMobile } = useDeviceLayout();
  const { themeState } = useTheme();
  const { glowEnabled } = useBackground();

  // Every authenticated page passes through this layout, which makes it the
  // one place a page-load check reaches "across all pages".
  useUnsyncedImportsNotice();

  if (isMobile) {
    return (
      <PowerRailProvider variant="overlay">
        {/* Top padding is the status-bar tap target (see useStatusBarScrollToTop). */}
        <div className="flex h-[var(--vv-height,100dvh)] max-h-[var(--vv-height,100dvh)] flex-col pt-[var(--safe-area-top)]">
          {/* Viewport-fixed; default 16px top sits under the status bar /
              Dynamic Island. Offset past safe-area + the phone header so the
              toast is in the content well, not the notch. */}
          <Toaster
            position="top-center"
            offset={{ top: 'calc(var(--safe-area-top) + 3.5rem)' }}
            mobileOffset={{ top: 'calc(var(--safe-area-top) + 3.5rem)' }}
            theme={themeState.mode}
          />
          <MobileTopBar />
          <main className="flex-1 min-w-0 overflow-hidden min-h-0 relative">
            <Suspense fallback={<LoadingPage />}>
              <Outlet />
              <Portal id="content-modal" className="absolute inset-0 empty:hidden" />
            </Suspense>
          </main>
          <MobileNavigation />
          <Portal id="overlay-modal" className="fixed inset-0 z-50 empty:hidden" />
        </div>
      </PowerRailProvider>
    );
  }

  return (
    <PowerRailProvider>
      {/* Scenery, behind everything. `relative z-10` on the shell is what keeps
          it there: the background is `fixed` at z-index 0, and a positioned
          sibling later in the DOM would otherwise paint over the whole app. */}
      {glowEnabled ? <AnimatedBackground /> : null}
      <div className="relative z-10 grid h-lvh min-h-0 grid-cols-[auto_1fr] grid-rows-[auto_1fr]">
        {/* Left-aligned so the mark stays put when the rail widens. Centering
            it here walks the logo to the middle of the expanded column. */}
        {/* No padding here: the toggle carries the drawer's own width and
            inset, so the two line up as one edge. */}
        {/* Stretch with the header row, then center the mark so leftover
            space is equal above and below — otherwise the toggle sits at the
            top of a taller PrimaryNavigation cell and looks bottom-heavy. */}
        <div className="flex items-center bg-secondary">
          <PowerRailToggle />
        </div>

        <div className="bg-secondary/20 border-b border-b-secondary/90">
          <PrimaryNavigation />
        </div>

        {/* No background or border here: the rail is a drawer that floats over
            the content when hovered, so it owns its own surface. Painting the
            lane too would double the tint wherever the two overlap. */}
        <SecondaryNavigation />

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
    </PowerRailProvider>
  );
}
