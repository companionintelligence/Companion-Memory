import { type ReactNode } from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetUnsyncedImportsNoticeForTests } from '@/components/UnsyncedImports/useUnsyncedImportsNotice';

import { Main } from './Main';
import { usePowerRail } from './PowerRailContext';

/**
 * Where the "You have unsynced imports" notice sits in the shell.
 *
 * It was a toast: `position: fixed` at z-index 999999999, so it painted over an
 * open dialog's title and close button, over the Sources switch and the Plan Add
 * field after every launch, and — with the phone drawer open — stayed on top of
 * the drawer while `MobileNavigation` made it `inert`, so a tap on it fell
 * through to the Capture row under it. Chrome and the page are mocked out here;
 * the layout, its portal slots, the drawer's inert handling and the notice are
 * real, because the order they sit in is the thing under test.
 */

const layout = vi.hoisted(() => ({ isMobile: true }));

vi.mock('@ci/common', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();

  return { ...original, useDeviceLayout: () => ({ isMobile: layout.isMobile }) };
});

vi.mock('@/components/ThemePicker', () => ({
  useTheme: () => ({ themeState: { mode: 'light' } }),
  useBackground: () => ({ glowEnabled: false }),
}));
// The shell reads the signed-in user to hold the unsynced-imports row back while
// the getting-started banner is up; neither is under test here.
vi.mock('@/hooks', () => ({ useCurrentUser: () => ({ user: null }) }));
vi.mock('@/components/GettingStarted/GettingStartedBanner', () => ({ GettingStartedBanner: () => null }));
vi.mock('@/components/AnimatedBackground', () => ({ AnimatedBackground: () => null }));
vi.mock('@/components/AppErrorBoundary', () => ({
  AppErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/MemoryContractStrip/MemoryContractStrip', () => ({
  MemoryContractStrip: () => <p data-testid="contract-strip">Please update your Memory app.</p>,
}));

vi.mock('./MobileNavigation/MobileTopBar', () => ({
  MobileTopBar: function MobileTopBar() {
    const { toggle } = usePowerRail();

    return (
      <header data-testid="top-bar">
        <button type="button" onClick={toggle}>
          Open menu
        </button>
      </header>
    );
  },
}));
vi.mock('./PowerRailToggle', () => ({ PowerRailToggle: () => <div data-testid="rail-toggle" /> }));
vi.mock('./PrimaryNavigation', () => ({ PrimaryNavigation: () => <nav data-testid="primary-navigation" /> }));
// The real drawer is heavy; `MobileNavigation` only needs an element with this id to inert around.
vi.mock('./SecondaryNavigation', () => ({
  SecondaryNavigation: () => <nav id="power-rail" aria-label="Drawer" />,
}));

const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });

vi.mock('@ci/shadcn', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();

  return { ...original, useToast: () => ({ toast }) };
});

const API = {
  ready: true,
  listUnpushed: vi.fn(async (): Promise<unknown[]> => [{ id: 'run-1' }]),
  startPush: vi.fn(async () => ({ runs: [{ id: 'run-1' }] })),
};

vi.mock('@/pages/ImportPage/useImportApi', () => ({
  useImportApi: () => API,
}));

function renderMain() {
  return render(
    <MemoryRouter initialEntries={['/sources']}>
      <Routes>
        <Route element={<Main />}>
          <Route path="*" element={<div data-testid="page">The page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** Every node comes after the one before it in document order. */
function expectInOrder(...nodes: Element[]) {
  nodes.slice(1).forEach((node, index) => {
    expect(nodes[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUnsyncedImportsNoticeForTests();
  layout.isMobile = true;
});

describe('Main: the unsynced-imports notice', () => {
  it('on a phone, is a row of the column between the header and the page, ahead of the modal slot', async () => {
    renderMain();

    const banner = await screen.findByTestId('unsynced-imports-notice');
    const page = screen.getByRole('main');
    const overlay = document.getElementById('overlay-modal') as HTMLElement;

    // A sibling of the page in the same flex column: the column gives it its own
    // height, so the page starts below it instead of underneath it.
    expect(banner.parentElement).toBe(page.parentElement);
    expectInOrder(screen.getByTestId('top-bar'), screen.getByTestId('contract-strip'), banner, page, overlay);
    // Modals portal into this slot (`fixed inset-0 z-50`), which is later in the
    // tree and so over anything in the flow.
    expect(overlay).toHaveClass('fixed', 'z-50');
    // And it is not a toast: no sonner container holds it.
    expect(banner.closest('[data-sonner-toaster]')).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('on desktop, is the top of the content column, above the page', async () => {
    layout.isMobile = false;

    renderMain();

    const banner = await screen.findByTestId('unsynced-imports-notice');
    const page = screen.getByRole('main');

    expect(banner.parentElement).toContainElement(page);
    expectInOrder(screen.getByTestId('contract-strip'), banner, page);
    expect(banner.closest('[data-sonner-toaster]')).toBeNull();
  });

  it('with the phone drawer open, is page content behind the scrim: inert, not floating over the drawer', async () => {
    renderMain();

    const banner = await screen.findByTestId('unsynced-imports-notice');

    expect(banner).not.toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    // Inert and underneath. As a toast it was inert and ON TOP, which is how a
    // tap on it reached the drawer row beneath.
    await waitFor(() => expect(banner).toHaveAttribute('inert'));
    expect(screen.getByRole('navigation', { name: 'Drawer' })).not.toHaveAttribute('inert');
  });
});

describe('Main: toasts with the phone drawer open', () => {
  // The same fall-through as the notice's, for every other toast: sonner paints
  // them at z-index 999999999, over the drawer, so one raised just before the
  // drawer opens (a "Syncing 3 imports." still on screen) is visible there. If the
  // Toaster is a child of the column `MobileNavigation` makes inert, it cannot be
  // hit, and a tap on the visible toast reaches the drawer row under it.
  it('keeps the toaster out of the column the drawer makes inert', async () => {
    renderMain();

    const banner = await screen.findByTestId('unsynced-imports-notice');
    const toaster = screen.getByRole('region', { name: /^Notifications/ });

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    await waitFor(() => expect(banner).toHaveAttribute('inert'));
    expect(toaster).not.toHaveAttribute('inert');
    expect(toaster.parentElement).not.toBe(banner.parentElement);
  });
});
