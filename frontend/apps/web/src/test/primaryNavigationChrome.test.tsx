/**
 * Where the status chips live in the desktop chrome.
 *
 * They used to render in a `fixed top-2 right-2` overlay owned by the Main
 * layout, which is pinned to the viewport rather than to any layout box — and
 * the desktop layout's own header puts the add menu and the account avatar in
 * exactly that corner. The overlay sat on top of both, hiding them behind
 * whatever the chip's label happened to be (worst with the widest one, "Not
 * synced yet"). The chips belong in the header's flow, where the header's own
 * layout accounts for them.
 *
 * Phone chrome puts the same chips and Add control in `MobileTopBar`, in flow
 * next to search. Nothing here applies to that layout.
 */

import { type ReactNode } from 'react';

import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import { ConnectionModeProvider } from '@ci/common/src/utils/connectionMode';
import { OutboxQueueProvider } from '@ci/common/src/utils/outboxFlush';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { okResponse, urlOf } from './fetchFakes';
import { renderWithProviders } from './renderWithProviders';

/** The chip's own providers, nested as App.tsx nests them. */
function ChipProviders({ children }: { children: ReactNode }) {
  return (
    <ConnectionModeProvider args={[]}>
      <OutboxQueueProvider args={[]}>{children}</OutboxQueueProvider>
    </ConnectionModeProvider>
  );
}

// Auth / Model / Features context all fetch on mount, so `renderWithProviders`
// deliberately does not provide them — components that consume them stub them
// instead (the documented pattern). The header still mounts the capture modal
// from the add menu (auth, model).
vi.mock('@/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/hooks')>('@/hooks');

  return {
    ...actual,
    useAuth: () => [{ isAuthenticated: true, authToken: 'token' }, { logout: vi.fn() }],
    useCurrentUser: () => ({ user: { name: 'Test User', email: 'test@example.com', onboarded: true } }),
    useModel: () => [{ selectedVisionModel: null }, { setSelectedVisionModel: vi.fn() }],
  };
});

vi.mock('@/common/feature', async () => {
  const actual = await vi.importActual<typeof import('@/common/feature')>('@/common/feature');

  return { ...actual, useFeatures: () => ({ isFeatureEnabled: () => true }) };
});

// The header mounts every add-menu modal (closed) alongside the chrome, and
// each drags in its own context graph — chat requester, uploads, things.
// None of that bears on where the chips sit, so the modals are stubbed out
// rather than provided for.
vi.mock('@/components/modals/CaptureModal', () => ({ CaptureModal: () => null }));
vi.mock('@/components/modals/UploadModal', () => ({ UploadModal: () => null }));
vi.mock('@/components/modals/AddItemModal', () => ({
  AddEventModal: () => null,
  AddPersonModal: () => null,
  AddPlaceModal: () => null,
}));
vi.mock('@/components/modals/AddItemModal/AddConceptModal.tsx', () => ({ AddConceptModal: () => null }));
vi.mock('@/components/modals/ThingModal', () => ({ ThingModal: () => null }));

beforeEach(() => {
  // An unreachable appliance is the case that produced the report: it resolves
  // to the widest label, "Not synced yet".
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      if (urlOf(input).includes('/api/health')) {
        throw new Error('appliance unreachable');
      }

      return okResponse();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiBaseUrl('');
  setApiKey(null);
});

describe('PrimaryNavigation — status chips', () => {
  it('renders the connection chip inside the header, not in a viewport-pinned overlay over it', async () => {
    // Imported lazily so the module-level mocks above are in place first.
    const { PrimaryNavigation } = await import('@/layouts/Main/PrimaryNavigation');

    const { container } = renderWithProviders(
      <ChipProviders>
        <PrimaryNavigation />
      </ChipProviders>,
      { withTheme: true },
    );

    const chip = await waitFor(() => screen.getByText('Not synced yet'));
    const header = container.querySelector('header');

    expect(header).not.toBeNull();
    expect(header).toContainElement(chip);

    // Nothing between the chip and the header may take it out of flow: a
    // `fixed`/`absolute` ancestor is what let it land on top of the controls.
    // Responsive variants count — `md:fixed` lifts it out on exactly the wide
    // viewports this test speaks for — so an optional `<variant>:` prefix is
    // part of the match. `className` is coerced because on an SVG element it
    // is an SVGAnimatedString rather than a string.
    const outOfFlow = /(^|\s)(?:[\w-]+:)*(fixed|absolute)(\s|$)/;

    for (let node = chip.parentElement; node && node !== header; node = node.parentElement) {
      expect(String(node.className)).not.toMatch(outOfFlow);
    }
  });

  it('keeps the add menu clickable rather than covered by the chip', async () => {
    const { PrimaryNavigation } = await import('@/layouts/Main/PrimaryNavigation');

    renderWithProviders(
      <ChipProviders>
        <PrimaryNavigation />
      </ChipProviders>,
      { withTheme: true },
    );

    const chip = await waitFor(() => screen.getByText('Not synced yet'));

    // Account moved into the rail. The chip shares the header flow row with
    // Add, so the row lays them out side by side instead of stacking the chip
    // on top of the primary action.
    const addButton = screen.getByRole('button', { name: 'Add' });
    const cluster = chip.closest('div')?.parentElement;

    expect(cluster).not.toBeNull();
    expect(cluster).toContainElement(addButton);
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('makes Add the visually primary header action', async () => {
    const { PrimaryNavigation } = await import('@/layouts/Main/PrimaryNavigation');

    renderWithProviders(
      <ChipProviders>
        <PrimaryNavigation />
      </ChipProviders>,
      { withTheme: true },
    );

    expect(screen.getByRole('button', { name: 'Add' })).toHaveClass('ci-primary-surface');
  });
});
