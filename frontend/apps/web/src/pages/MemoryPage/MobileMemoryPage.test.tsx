import type { MockedResponse } from '@apollo/client/testing';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

// EntityServiceProvider's `args` are what every child page (desktop or
// mobile) reads its filters from — capturing them lets the saved-search test
// below observe the resolved filters without unmocking the real search query.
const h = vi.hoisted(() => ({ capturedArgs: undefined as unknown }));

vi.mock('../MemoryPage/useEntityService', () => ({
  useEntityService: () => [{ activeEntity: null, refetch: vi.fn() }, { setActiveEntity: vi.fn() }],
  EntityServiceProvider: ({ args, children }: { args: [unknown]; children?: React.ReactNode }) => {
    h.capturedArgs = args[0];

    return <>{children}</>;
  },
}));

vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children, actions }: { children?: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));

vi.mock('./Components/ExplorerToolbar/ExplorerToolbar', () => ({
  ExplorerToolbar: () => <div data-testid="explorer-filters" />,
}));

vi.mock('./ListView', () => ({ ListView: () => <div>list</div> }));
vi.mock('./ExploreView', () => ({ ExploreView: () => <div>explore</div> }));
vi.mock('./MapView', () => ({ MobileMapView: () => <div>map</div> }));
vi.mock('./StoryTimelineView', () => ({ StoryTimelineView: () => <div>timeline</div> }));
vi.mock('./GalleryView', () => ({ GalleryView: () => <div>gallery</div> }));
vi.mock('./GraphView', () => ({ GraphView: () => <div>graph</div> }));
vi.mock('./Components', () => ({ EntityDetails: () => null }));
vi.mock('@/components/modals/FileChunkModal/FileChunkModal', () => ({ FileChunkModal: () => null }));

import { MemoryPage } from './MemoryPage';
import MobileMemoryPage from './MobileMemoryPage';
import { GET_SAVED_SEARCH } from './useSavedSearchResolution';

describe('MobileMemoryPage', () => {
  it('does not render a second search box or a page-level Add — those live in the top bar', () => {
    renderWithProviders(<MobileMemoryPage />, { route: '/memory?view=list' });

    expect(screen.queryByPlaceholderText(/search your memory/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new event/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /list/i })).toBeInTheDocument();
    expect(screen.getByTestId('explorer-filters')).toBeInTheDocument();
  });

  it('offers the Timeline view on /memory only inside a When filter', () => {
    const { unmount } = renderWithProviders(<MobileMemoryPage />, { route: '/memory?view=list' });

    expect(screen.queryByRole('tab', { name: /timeline/i })).not.toBeInTheDocument();
    unmount();

    renderWithProviders(<MobileMemoryPage />, {
      route: '/memory?view=list&when=last-week&from=2026-01-01T00:00:00.000Z&to=2026-01-07T23:59:59.999Z',
    });

    expect(screen.getByRole('tab', { name: /timeline/i })).toBeInTheDocument();
  });

  it('always offers the Timeline view on the events browse', () => {
    renderWithProviders(<MobileMemoryPage />, { route: '/memory/events?view=list' });

    expect(screen.getByRole('tab', { name: /timeline/i })).toBeInTheDocument();
  });
});

// useDeviceLayout (ResponsiveLoader's mobile/desktop switch) reads
// window.matchMedia; drive it to force the mobile branch, same pattern as
// ResponsiveLoader.test.tsx.
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

afterEach(() => setViewport(false));

/**
 * H2 (UI/UX audit): opening a saved search on a phone used to silently
 * ignore it — only DesktopMemoryPage read `?saved_search`. The resolution
 * now lives in the shared MemoryPage parent (useSavedSearchResolution), so
 * this renders the real MemoryPage — not MobileMemoryPage in isolation —
 * under a forced mobile viewport, the same entry point a phone actually
 * uses when opening a saved-search link.
 */
describe('MemoryPage — ?saved_search on a mobile viewport', () => {
  it('resolves the saved search into the explorer filters the same way desktop already does', async () => {
    setViewport(true);
    h.capturedArgs = undefined;

    const savedSearchMock: MockedResponse = {
      request: { query: GET_SAVED_SEARCH },
      variableMatcher: () => true,
      result: {
        data: {
          savedSearch: {
            __typename: 'SavedSearchType',
            id: 'saved-search-1',
            name: 'Sunset trips',
            description: null,
            query: 'sunset',
            entityTypes: [],
            tags: ['travel'],
            filters: {
              __typename: 'SavedSearchFiltersType',
              eventTypes: null,
              startTime: null,
              endTime: null,
              datePreset: null,
              sortBy: null,
              sortOrder: null,
              connectors: null,
              people: null,
              places: null,
              hasLocation: true,
              semantic: null,
            },
          },
        },
      },
    };

    renderWithProviders(<MemoryPage />, {
      route: '/memory?saved_search=abc123',
      mocks: [savedSearchMock],
    });

    // Confirms the mobile branch is what actually rendered (not desktop).
    expect(await screen.findByRole('tab', { name: /list/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(h.capturedArgs).toMatchObject({
        searchQuery: 'sunset',
        tags: ['travel'],
        hasLocation: true,
      });
    });
  });
});
