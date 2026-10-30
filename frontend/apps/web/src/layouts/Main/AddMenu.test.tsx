/**
 * Two of the Add menu's modals have to refresh something after they write.
 *
 * `ThingModal` used to splice the new thing into every cached `items`
 * field itself (a `cache.modify` block); that was replaced by an `onSaved`
 * callback, and this call site was left without one — so a thing created from
 * "+" stayed invisible until a manual reload, including on the Things browse
 * the user was looking at when they created it.
 *
 * `AddEventModal` is the same hazard arriving by a different route: the Memory
 * explorer used to carry its own "New event" button wired to that page's
 * `refetch`, and when that button was folded into this menu the refresh had to
 * come with it. AddMenu renders above `EntityServiceProvider`, so it cannot
 * reach that `refetch` — it evicts the root `search`/`mapPins` fields instead.
 */

import { useEffect } from 'react';

import { type ApolloClient, useApolloClient } from '@apollo/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET_THINGS, PAGE_SIZE } from '@/pages/ThingsPage/ThingsPage';
import { renderWithProviders } from '@/test/renderWithProviders';

import { AddMenu } from './AddMenu';

const savedProps: { onSaved?: () => Promise<unknown> | void }[] = [];
const eventProps: { onCreated?: () => Promise<unknown> | void }[] = [];

vi.mock('@/components/modals/ThingModal', () => ({
  ThingModal: (props: { onSaved?: () => Promise<unknown> | void }) => {
    savedProps.push(props);

    return null;
  },
}));

// Every other modal drags in its own context graph, and none of them is what
// this test is about.
vi.mock('@/components/modals/CaptureModal', () => ({ CaptureModal: () => null }));
vi.mock('@/components/modals/UploadModal', () => ({ UploadModal: () => null }));
vi.mock('@/components/modals/AddItemModal', () => ({
  AddEventModal: (props: { onCreated?: () => Promise<unknown> | void }) => {
    eventProps.push(props);

    return null;
  },
  AddPersonModal: () => null,
  AddPlaceModal: () => null,
}));
vi.mock('@/components/modals/AddItemModal/AddConceptModal.tsx', () => ({ AddConceptModal: () => null }));
vi.mock('@/components/modals/ScanBarcodeModal', () => ({ ScanBarcodeModal: () => null }));

// Both hooks read providers the harness deliberately does not supply.
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>();

  return {
    ...actual,
    useUploadFile: () => [{}, { upload: vi.fn(), reset: vi.fn() }],
    useTriggerHbpe: () => [{}, { trigger: vi.fn() }],
  };
});

const THINGS_VARIABLES = {
  query: null,
  category: null,
  brand: null,
  condition: null,
  lifecycleState: null,
  hasIdentifier: null,
  sort: 'RECENTLY_SEEN' as const,
  first: PAGE_SIZE,
};

/** Grabs the same client AddMenu is using, out of the shared provider. */
function ClientProbe({ onClient }: { onClient: (client: ApolloClient<object>) => void }) {
  const client = useApolloClient();

  useEffect(() => onClient(client as ApolloClient<object>), [client, onClient]);

  return null;
}

async function renderAddMenu(): Promise<ApolloClient<object>> {
  savedProps.length = 0;
  eventProps.length = 0;

  let captured: ApolloClient<object> | null = null;

  renderWithProviders(
    <>
      <AddMenu />
      <ClientProbe
        onClient={(next) => {
          captured = next;
        }}
      />
    </>,
  );

  await waitFor(() => expect(captured).not.toBeNull());

  return captured as unknown as ApolloClient<object>;
}

describe('AddMenu', () => {
  it('gives the Thing modal an onSaved — without one a new thing never appears', async () => {
    await renderAddMenu();

    expect(savedProps.length).toBeGreaterThan(0);
    expect(typeof savedProps.at(-1)?.onSaved).toBe('function');
  });

  it('refreshes every active browse that reads `items`, by evicting the root field', async () => {
    const client = await renderAddMenu();

    const refetchQueries = vi.spyOn(client, 'refetchQueries').mockResolvedValue([]);

    // Seed the cache the way a browse behind the menu would have.
    client.cache.writeQuery({
      query: GET_THINGS,
      variables: THINGS_VARIABLES,
      data: {
        items: {
          __typename: 'ItemConnection',
          totalCount: 0,
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
          edges: [],
        },
      },
    });

    const itemFields = () =>
      Object.keys(
        ((client.cache.extract() as Record<string, unknown>).ROOT_QUERY ?? {}) as Record<string, unknown>,
      ).filter((key) => key.startsWith('items'));

    expect(itemFields().length).toBeGreaterThan(0);

    await savedProps.at(-1)?.onSaved?.();

    expect(refetchQueries).toHaveBeenCalledTimes(1);

    // The refresh is expressed as a cache UPDATE, so Apollo re-runs exactly the
    // active queries the eviction touched — the nav never has to know which
    // pages happen to list things.
    const options = refetchQueries.mock.calls[0]![0] as {
      updateCache: (cache: typeof client.cache) => void;
    };

    options.updateCache(client.cache);

    expect(itemFields()).toEqual([]);
  });

  it('gives the Event modal an onCreated — the explorer has no other create affordance', async () => {
    await renderAddMenu();

    expect(eventProps.length).toBeGreaterThan(0);
    expect(typeof eventProps.at(-1)?.onCreated).toBe('function');
  });

  it('refreshes the explorer and the map by evicting the root `search`/`mapPins` fields', async () => {
    const client = await renderAddMenu();

    const refetchQueries = vi.spyOn(client, 'refetchQueries').mockResolvedValue([]);

    // The explorer's `search` and the map's `mapPins` are server-composed
    // connections, so seed them as the raw root fields Apollo actually writes
    // (there is no exported document to writeQuery through).
    client.cache.restore({
      ROOT_QUERY: {
        __typename: 'Query',
        'search({"input":{"query":""}})': { __typename: 'SearchConnection', totalCount: 0, edges: [] },
        'mapPins({"input":{"query":""}})': { __typename: 'MapPinsType', totalCount: 0, pins: [] },
      },
    });

    const rootFields = (prefix: string) =>
      Object.keys(
        ((client.cache.extract() as Record<string, unknown>).ROOT_QUERY ?? {}) as Record<string, unknown>,
      ).filter((key) => key.startsWith(prefix));

    expect(rootFields('search').length).toBeGreaterThan(0);
    expect(rootFields('mapPins').length).toBeGreaterThan(0);

    await eventProps.at(-1)?.onCreated?.();

    expect(refetchQueries).toHaveBeenCalledTimes(1);

    const options = refetchQueries.mock.calls[0]![0] as {
      updateCache: (cache: typeof client.cache) => void;
    };

    options.updateCache(client.cache);

    // Both, not just the explorer: an event created with a location is a new
    // pin, and the map would otherwise keep serving the pre-create set.
    expect(rootFields('search')).toEqual([]);
    expect(rootFields('mapPins')).toEqual([]);
  });
});

// useDeviceLayout reads window.matchMedia; drive it to force the phone
// branch, the same pattern as MobileMemoryPage.test.tsx.
function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : query.includes('landscape') ? !mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('the Add menu on a phone', () => {
  afterEach(() => {
    setViewport(false);
    document.body.style.pointerEvents = '';
  });

  function openMenu() {
    // Radix's DropdownMenuTrigger opens on pointerdown, not click.
    fireEvent.pointerDown(screen.getByRole('button', { name: /NAV_ADD|add/i }), { button: 0 });

    return screen.findByRole('menu');
  }

  it('opens modal, so a tap away only closes it and presses nothing underneath', async () => {
    setViewport(true);
    await renderAddMenu();
    await openMenu();

    // Radix's modal layer turns pointer events off for the rest of the page,
    // and the shield catches what that misses (map pins and the like, which
    // turn them back on for themselves): a tap on it is an outside press.
    expect(document.body.style.pointerEvents).toBe('none');
    const shield = screen.getByTestId('menu-shield');

    expect(shield).toHaveClass('max-device:block', 'pointer-events-auto');

    fireEvent.pointerDown(shield, { button: 0 });
    fireEvent.click(shield);

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.queryByTestId('menu-shield')).not.toBeInTheDocument();
  });

  it('stays non-modal on desktop, where the shield is only ever hidden', async () => {
    await renderAddMenu();
    await openMenu();

    expect(document.body.style.pointerEvents).toBe('');
    // Present but display:none above the phone breakpoint — a desktop click
    // outside is meant to reach what it hits.
    expect(screen.getByTestId('menu-shield')).toHaveClass('hidden');
  });
});
