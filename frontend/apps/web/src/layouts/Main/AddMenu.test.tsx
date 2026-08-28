/**
 * The Add menu's Thing modal is the ONE modal here that has to refresh
 * something after it writes.
 *
 * `ThingModal` used to splice the new thing into every cached `items`
 * field itself (a `cache.modify` block); that was replaced by an `onSaved`
 * callback, and this call site was left without one — so a thing created from
 * "+" stayed invisible until a manual reload, including on the Things browse
 * the user was looking at when they created it.
 */

import { useEffect } from 'react';

import { type ApolloClient, useApolloClient } from '@apollo/client';
import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GET_THINGS, PAGE_SIZE } from '@/pages/ThingsPage/ThingsPage';
import { renderWithProviders } from '@/test/renderWithProviders';

import { AddMenu } from './AddMenu';

const savedProps: { onSaved?: () => Promise<unknown> | void }[] = [];

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
  AddEventModal: () => null,
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
});
