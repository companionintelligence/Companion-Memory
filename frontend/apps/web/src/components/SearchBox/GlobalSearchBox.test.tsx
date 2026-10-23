/**
 * The header/global search box: the single free-text entry point that also
 * drives the Memory Explorer's `?search=` URL state (the exact param this
 * session found the backend fabricating a `totalCount` for). This suite
 * exercises what actually lands in the URL/route when a person types,
 * submits, or clears — the part most likely to silently break in a refactor
 * — not the dropdown's visual contents (each result row has its own tests).
 */
import { GlobalUID } from '@ci/common';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { GlobalSearchBox } from './GlobalSearchBox';

const h = vi.hoisted(() => ({
  search: {
    data: [] as unknown[],
    tags: [] as { id: string; label: string }[],
    loading: false,
    error: undefined as unknown,
  } as {
    data: unknown[];
    tags: { id: string; label: string }[];
    loading: boolean;
    error: unknown;
    /** Where the results came from; the box opens device answers at the saved record page. */
    source?: string;
  },
}));

// GlobalSearchBox's own job is turning a typed/committed query and a selected
// suggestion into URL state and navigation — not fetching. Stubbing the
// network hook lets each test control exactly which suggestions/tags are on
// screen without reproducing the SEARCH_QUERY document or Apollo mocks.
vi.mock('./useSearchService', () => ({
  useSearchService: () => h.search,
}));

// Off `/memory`, the panel footer mounts the full advanced-filter surface
// (ExplorerToolbar's SearchPanelFilters), which reaches for useFeatures/
// useAuth/useMutation context this test doesn't provide. GlobalSearchBox only
// composes it in; assert that composition without dragging its internals in.
vi.mock('@/pages/MemoryPage/Components/ExplorerToolbar/ExplorerToolbar', () => ({
  // Load search stands in as one button that hands over a picked search.
  SearchPanelFilters: ({ onOpenSavedSearch }: { onOpenSavedSearch?: (params: URLSearchParams) => void }) => (
    <>
      <div>advanced filters</div>
      <button
        type="button"
        onClick={() => onOpenSavedSearch?.(new URLSearchParams('search=paris&tags=vacation'))}
      >
        Load a saved search
      </button>
    </>
  ),
}));

// The phone footer (its sheets have their own suite); here, only what the box
// hands it.
vi.mock('@/pages/MemoryPage/Components/ExplorerToolbar/MobileSearchPanelFilters', () => ({
  MobileSearchPanelFilters: ({
    filterCount,
    showSavedSearches,
  }: {
    filterCount: number;
    showSavedSearches: boolean;
  }) => (
    <div>
      phone filters: {filterCount}
      {showSavedSearches && ', saved searches'}
    </div>
  ),
}));

const desktopMatchMedia = window.matchMedia;

/** A phone-width viewport, as useDeviceLayout reads it (`max-width` queries match). */
function asPhone() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function LocationProbe() {
  const location = useLocation();

  return (
    <>
      <div data-testid="path">{location.pathname}</div>
      <div data-testid="query">{location.search}</div>
    </>
  );
}

function renderAt(route: string) {
  return renderWithProviders(
    <>
      <GlobalSearchBox />
      <LocationProbe />
    </>,
    { route },
  );
}

/** Current route's query params, read off the LocationProbe — order-independent. */
function params(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('query').textContent ?? '');
}

function path(): string {
  return screen.getByTestId('path').textContent ?? '';
}

/** Same gesture SearchBox itself requires before it will open on focus: a pointer engagement, then focus. */
function engage(input: HTMLElement) {
  fireEvent.pointerDown(input);
  fireEvent.focus(input);
}

beforeEach(() => {
  localStorage.clear();
  h.search = { data: [], tags: [], loading: false, error: undefined };
});

afterEach(() => {
  window.matchMedia = desktopMatchMedia;
});

describe('GlobalSearchBox on /memory/events', () => {
  it('writes the typed query live into ?search= (debounced)', async () => {
    renderAt('/memory/events');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'latte' } });

    await waitFor(() => expect(params().get('search')).toBe('latte'));
    expect(path()).toBe('/memory/events');
  });

  it('removes ?search= once the input is cleared back to empty', async () => {
    renderAt('/memory/events?search=latte');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });

    await waitFor(() => expect(params().has('search')).toBe(false));
  });

  it('seeds the input from an existing ?search= param', () => {
    renderAt('/memory/events?search=vacation');

    expect(screen.getByRole('textbox')).toHaveValue('vacation');
  });

  it('Enter commits the trimmed text, leaves the box as-is, and remembers the query', async () => {
    renderAt('/memory/events');

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'latte  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(params().get('search')).toBe('latte'));
    // On /memory/events, commit deliberately does NOT remount (see the "Do NOT
    // remount here" comment in commitSearch in GlobalSearchBox.tsx): a
    // same-tick resetKey bump would remount before the async `search` param
    // update lands, feeding the fresh instance a stale-empty `defaultQuery`
    // that then deletes `search` right back out of the URL. The input keeps
    // showing exactly what was just committed instead.
    expect(screen.getByRole('textbox')).toHaveValue('latte');

    // The trimmed (not raw) query is what gets remembered for next time.
    expect(JSON.parse(localStorage.getItem('memoryRecentSearches') ?? '[]')).toEqual(['latte']);
  });

  it('X clears both the query and the pinned explorer filters, staying on /memory/events', () => {
    renderAt('/memory/events?search=foo&tags=vacation&notAFilter=keep');

    fireEvent.click(screen.getByRole('button', { name: /clear search and filters/i }));

    expect(path()).toBe('/memory/events');
    expect(params().has('search')).toBe(false);
    expect(params().has('tags')).toBe(false);
    // Only `search` + the known FILTER_PARAMS are swept — not every param on the URL.
    expect(params().get('notAFilter')).toBe('keep');
  });

  it('"Clear search filters" removes only the pinned filters, leaving the query box alone', () => {
    renderAt('/memory/events?tags=vacation&notAFilter=keep');

    engage(screen.getByRole('textbox'));
    fireEvent.click(screen.getByText('Clear search filters'));

    expect(params().has('tags')).toBe(false);
    expect(params().get('notAFilter')).toBe('keep');
  });

  it('clicking "Search Memory for …" commits the same as Enter', async () => {
    renderAt('/memory/events');

    const input = screen.getByRole('textbox');
    engage(input);
    fireEvent.change(input, { target: { value: 'latte' } });

    fireEvent.click(await screen.findByText('Search Memory for'));

    await waitFor(() => expect(params().get('search')).toBe('latte'));
  });
});

describe('GlobalSearchBox on a hub list page (people / places / things / tags / content)', () => {
  it('writes the typed query into the page in place, keeping its filters and sort', async () => {
    renderAt('/memory/things?sort=NEWEST&types=image');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'lamp' } });

    await waitFor(() => expect(params().get('search')).toBe('lamp'));
    expect(path()).toBe('/memory/things');
    expect(params().get('sort')).toBe('NEWEST');
    expect(params().get('types')).toBe('image');
  });

  it('Enter commits in place too — no jump to the explorer', async () => {
    renderAt('/memory/people?tags=vacation');

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Ada  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(params().get('search')).toBe('Ada'));
    expect(path()).toBe('/memory/people');
    expect(params().get('tags')).toBe('vacation');
  });

  it('shows no explorer filters in its panel — the page has its own, and these would be ignored', () => {
    renderAt('/memory/people?includedEntityTypes=Person');

    engage(screen.getByRole('textbox'));

    expect(screen.queryByText('advanced filters')).not.toBeInTheDocument();
  });

  it("seeds the input from the page's ?search= and X clears only the query", async () => {
    renderAt('/memory/content/42?search=shells&types=image');

    expect(screen.getByRole('textbox')).toHaveValue('shells');

    fireEvent.click(screen.getByRole('button', { name: /clear search and filters/i }));

    await waitFor(() => expect(params().has('search')).toBe(false));
    expect(path()).toBe('/memory/content/42');
    expect(params().get('types')).toBe('image');
  });
});

describe('GlobalSearchBox off the memory lists (jump-to launcher)', () => {
  it('offers the explorer filters in its panel, since Enter carries them to /memory', () => {
    renderAt('/dashboard');

    engage(screen.getByRole('textbox'));

    expect(screen.getByText('advanced filters')).toBeInTheDocument();
  });

  it('opens a saved search picked in the panel in the explorer, with its query in the box', async () => {
    renderAt('/plan/tasks?view=board');

    engage(screen.getByRole('textbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Load a saved search' }));

    await waitFor(() => expect(path()).toBe('/memory'));
    expect(params().get('search')).toBe('paris');
    expect(params().get('tags')).toBe('vacation');
    expect(params().has('view')).toBe(false);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('paris'));
  });

  it('does not write the current route while typing — only the "jump to" suggestions react', async () => {
    renderAt('/dashboard');

    const input = screen.getByRole('textbox');
    engage(input);
    fireEvent.change(input, { target: { value: 'latte' } });

    // The action row is driven by the same debounced state as the URL write
    // on /memory/events; its appearance proves the debounce landed.
    await screen.findByText('Search all of Memory for');

    expect(path()).toBe('/dashboard');
    expect(params().toString()).toBe('');
  });

  it('Enter navigates to /memory?search=… (everything, not the events browse), carrying forward pinned filters', () => {
    renderAt('/dashboard?tags=vacation');

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'latte' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(path()).toBe('/memory');
    expect(params().get('search')).toBe('latte');
    expect(params().get('tags')).toBe('vacation');
  });

  it('X on a /memory page with no searchable list resets back to the everything browse', () => {
    renderAt('/memory/notes?tags=vacation');

    fireEvent.click(screen.getByRole('button', { name: /clear search and filters/i }));

    expect(path()).toBe('/memory');
    expect(params().toString()).toBe('');
  });
});

describe('GlobalSearchBox suggestions', () => {
  it('shows recent searches on focus and commits the one clicked', () => {
    localStorage.setItem('memoryRecentSearches', JSON.stringify(['latte']));
    renderAt('/memory/events');

    engage(screen.getByRole('textbox'));
    fireEvent.click(screen.getByText('latte'));

    expect(params().get('search')).toBe('latte');
  });

  it("on a person's page, a recent search opens the search across Memory — the page has no list to filter", () => {
    localStorage.setItem('memoryRecentSearches', JSON.stringify(['latte']));
    renderAt('/people/42');

    engage(screen.getByRole('textbox'));
    fireEvent.click(screen.getByText('latte'));

    expect(path()).toBe('/memory');
    expect(params().get('search')).toBe('latte');
  });

  it('on a person\'s page, "Search all of Memory for …" opens the search across Memory', async () => {
    renderAt('/people/42');

    const input = screen.getByRole('textbox');
    engage(input);
    fireEvent.change(input, { target: { value: 'latte' } });

    fireEvent.click(await screen.findByText('Search all of Memory for'));

    expect(path()).toBe('/memory');
    expect(params().get('search')).toBe('latte');
  });

  it('on a list page, a recent search filters the page in place and lets go of the box, closing the panel', async () => {
    localStorage.setItem('memoryRecentSearches', JSON.stringify(['latte']));
    renderAt('/memory/people');

    // jsdom reports the document as never focused, which the box reads as the
    // window losing focus (and so keeps its panel); a real focused tab says yes.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    const input = screen.getByRole('textbox');
    input.focus();
    engage(input);
    fireEvent.click(screen.getByText('latte'));

    expect(path()).toBe('/memory/people');
    expect(params().get('search')).toBe('latte');
    expect(document.activeElement).not.toBe(input);
    await waitFor(() => expect(input).toHaveValue('latte'));
  });

  it('removing a recent search does not commit it', () => {
    localStorage.setItem('memoryRecentSearches', JSON.stringify(['latte']));
    renderAt('/memory/events');

    engage(screen.getByRole('textbox'));
    fireEvent.click(screen.getByRole('button', { name: /remove.*latte.*from recent searches/i }));

    expect(screen.queryByText('latte')).not.toBeInTheDocument();
    expect(params().has('search')).toBe(false);
  });

  it('selecting a matching tag filters the explorer by tag, not by free text', async () => {
    h.search = { data: [], tags: [{ id: 't1', label: 'vacation' }], loading: false, error: undefined };
    renderAt('/dashboard');

    const input = screen.getByRole('textbox');
    engage(input);
    fireEvent.change(input, { target: { value: 'vac' } });

    fireEvent.click(await screen.findByText('#vacation'));

    expect(path()).toBe('/memory');
    expect(params().get('tags')).toBe('vacation');
    expect(params().has('search')).toBe(false);
  });

  it('selecting a person suggestion decodes its GlobalUID and opens the detail route', async () => {
    h.search = {
      data: [
        {
          __typename: 'PersonType',
          id: GlobalUID.encode('person', '42'),
          name: 'Alice',
          filterName: 'Alice',
        },
      ],
      tags: [],
      loading: false,
      error: undefined,
    };
    renderAt('/dashboard');

    const input = screen.getByRole('textbox');
    engage(input);
    fireEvent.change(input, { target: { value: 'ali' } });

    fireEvent.click(await screen.findByText('Alice'));

    expect(path()).toBe('/people/42');
  });

  it('a suggestion answered from this phone opens the record this phone holds, whatever its type', async () => {
    h.search = {
      data: [
        {
          __typename: 'FileType',
          id: GlobalUID.encode('file', 'f1'),
          filename: 'scan.pdf',
          previewUrl: null,
        },
      ],
      tags: [],
      loading: false,
      error: undefined,
      source: 'device',
    };
    renderAt('/dashboard');

    const input = screen.getByRole('textbox');
    engage(input);
    fireEvent.change(input, { target: { value: 'scan' } });

    fireEvent.click(await screen.findByText('scan.pdf'));

    expect(path()).toBe('/memory/saved/file/f1');
  });

  // Files have no detail page; this tap used to do nothing at all, online or off.
  it('selecting a file suggestion opens the gallery searched for its name', async () => {
    h.search = {
      data: [
        {
          __typename: 'FileType',
          id: GlobalUID.encode('file', 'f1'),
          filename: 'scan 2026.pdf',
          previewUrl: null,
        },
      ],
      tags: [],
      loading: false,
      error: undefined,
    };
    renderAt('/dashboard');

    const input = screen.getByRole('textbox');
    engage(input);
    fireEvent.change(input, { target: { value: 'scan' } });

    fireEvent.click(await screen.findByText('scan 2026.pdf'));

    expect(`${path()}?${params().toString()}`).toBe('/memory?view=gallery&search=scan+2026.pdf');
  });
});

describe('GlobalSearchBox on a phone', () => {
  it('swaps the row of filter controls for the Filters and Saved searches rows', () => {
    asPhone();
    renderAt('/dashboard?tags=vacation');

    engage(screen.getByRole('textbox'));

    expect(screen.getByText('phone filters: 1, saved searches')).toBeInTheDocument();
    expect(screen.queryByText('advanced filters')).not.toBeInTheDocument();
  });

  it('keeps the Filters row alone under the suggestions once a query is typed', async () => {
    asPhone();
    renderAt('/dashboard');

    const input = screen.getByRole('textbox');
    engage(input);
    fireEvent.change(input, { target: { value: 'latte' } });

    await screen.findByText('Search all of Memory for');
    expect(screen.getByText('phone filters: 0')).toBeInTheDocument();
  });

  it('shows no explorer filters on a list page, as at desktop widths', () => {
    asPhone();
    renderAt('/memory/people');

    engage(screen.getByRole('textbox'));

    expect(screen.queryByText(/phone filters/)).not.toBeInTheDocument();
  });

  it('captions the recent searches, which only a phone needs', () => {
    localStorage.setItem('memoryRecentSearches', JSON.stringify(['latte', 'flat white']));
    asPhone();
    const { unmount } = renderAt('/dashboard');

    engage(screen.getByRole('textbox'));

    expect(screen.getAllByText('Recent')).toHaveLength(1);
    expect(
      screen.getByText('Recent').compareDocumentPosition(screen.getByText('latte')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    unmount();

    window.matchMedia = desktopMatchMedia;
    renderAt('/dashboard');
    engage(screen.getByRole('textbox'));

    expect(screen.getByText('latte')).toBeInTheDocument();
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
  });

  /**
   * QA MEM-05 re-test, P3: after "Open full page" on an entity sheet, the search box
   * showed its Filters / Saved searches panel over the new page's Back bar. The sheet's
   * icon and the page's search field share a spot on the screen, so the suspects were
   * focus handed back by the closing sheet, or a tap landing through onto the field.
   *
   * Neither is what happens. On an iOS 27 Simulator (real touch, WebKit) one tap on the
   * icon left the box shut 9 times in 9; a SECOND tap at that spot (a retried or
   * repeated tap) opened it all 3 times, which is simply a tap on the field. These two
   * hold that split in place so the gating cannot loosen unnoticed: a pointer gesture
   * opens the panel, bare focus never does.
   */
  it('stays shut when focus lands on it without a tap, as when a closing sheet hands focus back', () => {
    asPhone();
    renderAt('/events/42');

    fireEvent.focus(screen.getByRole('textbox'));

    expect(screen.queryByText(/phone filters/)).not.toBeInTheDocument();
  });

  it("opens on a tap on the field, which is all a second tap at the sheet icon's spot amounts to", () => {
    asPhone();
    renderAt('/events/42');

    engage(screen.getByRole('textbox'));

    expect(screen.getByText('phone filters: 0, saved searches')).toBeInTheDocument();
  });
});
