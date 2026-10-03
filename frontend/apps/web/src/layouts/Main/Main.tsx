import { Suspense } from 'react';

import { LoadingPage, Portal, useDeviceLayout } from '@ci/common';
import { Toaster } from '@ci/shadcn';
import { Outlet } from 'react-router-dom';

import { AnimatedBackground } from '@/components/AnimatedBackground';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { GettingStartedBanner } from '@/components/GettingStarted/GettingStartedBanner';
import { MemoryContractStrip } from '@/components/MemoryContractStrip/MemoryContractStrip';
import { useBackground, useTheme } from '@/components/ThemePicker';
import { UnsyncedImportsBanner } from '@/components/UnsyncedImports/UnsyncedImportsBanner';
import { useCurrentUser } from '@/hooks';
import { isGettingStartedActive } from '@/lib/gettingStarted';

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
  const { user } = useCurrentUser();
  const gettingStartedActive = isGettingStartedActive(user?.id);

  if (isMobile) {
    return (
      <PowerRailProvider variant="overlay">
        {/* Viewport-fixed; default 16px top sits under the status bar /
            Dynamic Island. Offset past safe-area + the phone header so the
            toast is in the content well, not the notch.

            A sibling of the column below, not a child of it, on purpose. While
            the drawer is open `MobileNavigation` makes every other child of
            that column `inert`, and an inert toast is still painted over the
            drawer (z-index 999999999) but cannot be hit — so a tap on it fell
            through to the drawer row beneath. Out here it stays tappable. */}
        <Toaster
          position="top-center"
          offset={{ top: 'calc(var(--safe-area-top) + 3.5rem)' }}
          mobileOffset={{ top: 'calc(var(--safe-area-top) + 3.5rem)' }}
          theme={themeState.mode}
        />
        {/* Top padding is the status-bar tap target (see useStatusBarScrollToTop). */}
        <div className="flex h-[var(--vv-height,100dvh)] max-h-[var(--vv-height,100dvh)] flex-col pt-[var(--safe-area-top)]">
          <MobileTopBar />
          <MemoryContractStrip />
          {/* A row of this column, not an overlay: the page starts below it, every
              modal slot after it paints over it, and while the drawer is open it is
              page content, inert behind the scrim like the rest. Every authenticated
              page passes through this layout, which makes it the one place the
              page-load check reaches "across all pages". */}
          <GettingStartedBanner />
          <UnsyncedImportsBanner suppressed={gettingStartedActive} />
          <main className="flex-1 min-w-0 overflow-hidden min-h-0 relative">
            {/* Boundary INSIDE Suspense so a failed lazy chunk is caught too,
                and around the outlet ALONE so the bottom bar and the modal
                portals survive a page crash. */}
            <Suspense fallback={<LoadingPage />}>
              <AppErrorBoundary>
                <Outlet />
              </AppErrorBoundary>
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
      {/* First focusable thing on every desktop page: keyboard users would
          otherwise tab through the whole rail and both navigations to reach the
          content. `sr-only` until focused, then `fixed` — `not-sr-only` resets
          position to static, which would drop it into the grid and shove the
          layout sideways the moment it takes focus. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
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
            the content when pinned open, so it owns its own surface. Painting
            the lane too would double the tint wherever the two overlap. */}
        <SecondaryNavigation />

        <div className="overflow-hidden min-w-0 min-h-0 flex flex-col">
          <MemoryContractStrip />
          {/* Same notice as the phone's, in the same slot: above the page, in flow. */}
          <GettingStartedBanner />
          <UnsyncedImportsBanner suppressed={gettingStartedActive} />
          <Suspense fallback={<LoadingPage />}>
            <Toaster theme={themeState.mode} />
            <div className="flex flex-row h-full min-h-0">
              <Portal id="tertiary-navigation" className="h-full" />
              {/* `tabIndex={-1}` so the skip link actually moves focus here
                  rather than only scrolling — a plain <main> is not focusable. */}
              <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 relative">
                {/* Around the outlet alone: the rail, both navigations and the
                    toaster stay mounted and usable when a page throws. */}
                <AppErrorBoundary>
                  <Outlet />
                </AppErrorBoundary>
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
