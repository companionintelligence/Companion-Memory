import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import {
  GET_PLACE_DUPLICATES,
  MERGE_PLACES,
  PLACE_DUPLICATE_PAGE_SIZE,
  PlaceDuplicatesCard,
  REJECT_PLACE_DUPLICATES,
} from './PlaceDuplicatesCard';

const PLACE_A = btoa('place:01a01c70-a291-720e-bd3e-516757a8c58d');
const PLACE_B = btoa('place:01a01c70-a363-726d-862f-57f87330ac60');

function place(id: string, lng: number) {
  return {
    __typename: 'PlaceType' as const,
    id,
    name: '61 Plantation, Irvine, CA, United States',
    description: null,
    placeKind: 'address',
    properties: { address: null, lat: 33.695, lng, source: 'reverse_geocode' },
  };
}

function duplicatesMock(groups: unknown[], maxUsageCount = 1) {
  return {
    request: { query: GET_PLACE_DUPLICATES, variables: { limit: PLACE_DUPLICATE_PAGE_SIZE, offset: 0 } },
    result: {
      data: {
        placeDuplicates: {
          __typename: 'PlaceDuplicatesPayload' as const,
          totalCount: groups.length,
          hasMore: false,
          groups,
        },
      },
    },
    maxUsageCount,
  };
}

const GROUP = {
  __typename: 'PlaceDuplicateGroupType' as const,
  reason: 'NAME_PROXIMITY',
  value: '61 Plantation, Irvine, CA, United States',
  totalPlaces: 2,
  places: [place(PLACE_A, -117.748), place(PLACE_B, -117.749)],
};

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('PlaceDuplicatesCard', () => {
  afterEach(() => setViewport(false));

  it('renders nothing when there is nothing to review', async () => {
    renderWithProviders(<PlaceDuplicatesCard onMerged={vi.fn(async () => undefined)} />, {
      mocks: [duplicatesMock([])],
    });

    await waitFor(() => expect(screen.queryByText(/Possible duplicate places/)).toBeNull());
  });

  it('offers the group for review, explaining why it was proposed', async () => {
    renderWithProviders(<PlaceDuplicatesCard onMerged={vi.fn(async () => undefined)} />, {
      mocks: [duplicatesMock([GROUP])],
    });

    expect(await screen.findByText('Possible duplicate places')).toBeInTheDocument();
    expect(screen.getByText(/Same name, within 150 m/)).toBeInTheDocument();
    // Each member shows its coordinates so an identically named pair can be told apart.
    expect(screen.getByText(/33\.69500, -117\.74800/)).toBeInTheDocument();
    expect(screen.getByText(/33\.69500, -117\.74900/)).toBeInTheDocument();
  });

  it('shows one clearly actionable group at a time on mobile', async () => {
    setViewport(true);
    const secondGroup = {
      ...GROUP,
      value: 'Second duplicate group',
      places: [
        { ...place(PLACE_A, -117.75), name: 'Second A' },
        { ...place(PLACE_B, -117.751), name: 'Second B' },
      ],
    };

    renderWithProviders(<PlaceDuplicatesCard onMerged={vi.fn(async () => undefined)} />, {
      mocks: [duplicatesMock([GROUP, secondGroup])],
    });

    expect((await screen.findAllByText(GROUP.value)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Second duplicate group')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Keep this place' })[0]).toHaveClass('border');
    expect(screen.getByRole('button', { name: 'Different places' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge places' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more suggestions' }));

    expect(await screen.findByText('Second duplicate group')).toBeInTheDocument();
  });

  it('merges only after the confirm dialog is accepted, then tells the page', async () => {
    const onMerged = vi.fn(async () => undefined);
    renderWithProviders(<PlaceDuplicatesCard onMerged={onMerged} />, {
      mocks: [
        duplicatesMock([GROUP], 3),
        {
          request: { query: MERGE_PLACES, variables: { input: { targetId: PLACE_A, sourceIds: [PLACE_B] } } },
          result: {
            data: {
              mergePlaces: {
                __typename: 'MergePlacesPayload' as const,
                success: true,
                place: { __typename: 'PlaceType' as const, id: PLACE_A, name: GROUP.value },
                counts: {
                  __typename: 'PlaceMergeCountsType' as const,
                  events: 3,
                  childPlaces: 0,
                  relationshipsFrom: 0,
                  relationshipsTo: 1,
                },
              },
            },
          },
        },
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Merge into one place' }));
    expect(onMerged).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Merge into one place?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge into one place' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
  });

  it('records a declined group with the whole group, no dialog', async () => {
    const onMerged = vi.fn(async () => undefined);
    renderWithProviders(<PlaceDuplicatesCard onMerged={onMerged} />, {
      mocks: [
        duplicatesMock([GROUP], 3),
        // Variables are the assertion: anything but both ids finds no mock.
        {
          request: { query: REJECT_PLACE_DUPLICATES, variables: { placeIds: [PLACE_A, PLACE_B] } },
          result: { data: { rejectPlaceDuplicates: true } },
        },
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Not the same place' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
    expect(screen.queryByText(/Could not record that/)).toBeNull();
  });
});
