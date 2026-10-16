/**
 * The header search panel's phone footer: a Filters row and a Saved searches
 * row, each opening a bottom sheet built from the same pickers as the desktop
 * row. What matters here is that the sheet shows each dimension's current
 * value, and that every control in it reads and writes the very URL params the
 * desktop controls do.
 */
import type { MockedResponse } from '@apollo/client/testing';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DropdownProvider, excludedEntityTypesFor } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';
import { GetSavedSearchDocument, GetSavedSearchesForPickerDocument } from '@/graphql/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { MobileSearchPanelFilters } from './MobileSearchPanelFilters';

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ isFeatureEnabled: () => false, loading: false, refresh: vi.fn() }),
}));

const SOURCE_SYSTEMS_QUERY = gql(`
  query SourceSystems($includeTypes: [String!], $excludeTypes: [String!]) {
    sourceSystems(includeTypes: $includeTypes, excludeTypes: $excludeTypes)
  }
`);

function savedSearchList(nodes: { id: string; name: string }[]) {
  return {
    savedSearches: {
      __typename: 'SavedSearchConnection' as const,
      totalCount: nodes.length,
      edges: nodes.map((node) => ({
        __typename: 'SavedSearchEdge' as const,
        node: { __typename: 'SavedSearchType' as const, description: null, ...node },
      })),
    },
  };
}

const TRIP_ID = btoa('saved-search:trip-1');

// The count row and the list both open with the same query; a few uses cover
// a test that reads the count and then opens the list.
const OWN_SAVED_SEARCHES = mockQuery(
  GetSavedSearchesForPickerDocument,
  { first: 8, query: undefined },
  savedSearchList([{ id: TRIP_ID, name: 'My trip' }]),
  { maxUsageCount: 3 },
);

function ParamsProbe() {
  const [params] = useSearchParams();
  const { pathname } = useLocation();

  return (
    <>
      <div data-testid="path">{pathname}</div>
      <div data-testid="params">{params.toString()}</div>
    </>
  );
}

function params(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('params').textContent ?? '');
}

function renderFooter(
  route: string,
  {
    filterCount = 0,
    showSavedSearches = true,
    onClearFilters = vi.fn(),
    onOpenSavedSearch = vi.fn(),
    mocks = [OWN_SAVED_SEARCHES],
  }: {
    filterCount?: number;
    showSavedSearches?: boolean;
    onClearFilters?: () => void;
    onOpenSavedSearch?: (params: URLSearchParams) => void;
    mocks?: readonly MockedResponse[];
  } = {},
) {
  return renderWithProviders(
    <DropdownProvider args={[{ changeSearchParams: true }]}>
      <ParamsProbe />
      <MobileSearchPanelFilters
        filterCount={filterCount}
        showSavedSearches={showSavedSearches}
        onClearFilters={onClearFilters}
        onOpenSavedSearch={onOpenSavedSearch}
      />
    </DropdownProvider>,
    { route, mocks },
  );
}

function openFilters() {
  fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));

  return screen.getByRole('dialog', { name: 'Filters' });
}

/** The row for one dimension inside the open sheet, found by its label. */
function row(sheet: HTMLElement, label: string) {
  return within(sheet).getByRole('button', { name: new RegExp(`^${label}\\b`) });
}

describe('MobileSearchPanelFilters', () => {
  it('shows the active-filter count on the Filters row and the user’s own saved-search count', async () => {
    renderFooter('/plan/tasks?people=Ada%20Lovelace&semantic=1', { filterCount: 2 });

    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveTextContent('2');
    expect(await screen.findByRole('button', { name: /^Saved searches\s*1/ })).toBeInTheDocument();
  });

  it('leaves Saved searches out while a query is typed', () => {
    renderFooter('/plan/tasks', { showSavedSearches: false });

    expect(screen.getByRole('button', { name: /^Filters/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Saved searches/ })).not.toBeInTheDocument();
  });

  it('opens a sheet with one row per dimension showing its current value', () => {
    const excluded = excludedEntityTypesFor(['Person', 'Event']).join(',');

    renderFooter(
      `/plan/tasks?excludedEntityTypes=${excluded}&people=Ada%20Lovelace&direction=inbound&when=last-week&from=2026-09-24T00:00:00.000Z&to=2026-09-30T23:59:59.999Z`,
    );

    const sheet = openFilters();

    expect(row(sheet, 'What')).toHaveTextContent('People, Events');
    expect(row(sheet, 'When')).toHaveTextContent('Last week');
    expect(row(sheet, 'How')).toHaveTextContent('All sources');
    expect(row(sheet, 'Activity')).toHaveTextContent('All activity');
    expect(row(sheet, 'Who')).toHaveTextContent('From Ada Lovelace');
    expect(row(sheet, 'Where')).toHaveTextContent('Anywhere');

    // Values that narrow the search read in the primary color; defaults don't.
    expect(within(row(sheet, 'What')).getByText('People, Events').parentElement).toHaveClass('text-primary');
    expect(within(row(sheet, 'How')).getByText('All sources').parentElement).not.toHaveClass('text-primary');
  });

  it('counts the map areas on the Where row beside the place names', () => {
    const { unmount } = renderFooter('/plan/tasks?areas=1,2,3,4;5,6,7,8');

    expect(row(openFilters(), 'Where')).toHaveTextContent('Map Areas (2)');
    unmount();

    renderFooter('/plan/tasks?areas=1,2,3,4&places=100%20Duranzo%20Aisle');

    const where = row(openFilters(), 'Where');

    expect(where).toHaveTextContent('1 selected + Map Areas (1)');
    expect(within(where).queryByText(/Duranzo/)).not.toBeInTheDocument();
  });

  it('keeps the count of further values visible beside a truncated summary', () => {
    renderFooter('/plan/tasks?people=Ada%20Lovelace&people=Alan%20Turing&people=Grace%20Hopper');

    const who = row(openFilters(), 'Who');

    expect(within(who).getByText('Ada Lovelace, Alan Turing')).toHaveClass('truncate');
    expect(within(who).getByText('+1')).toHaveClass('shrink-0');
  });

  it('offers only the dimensions the What selection can use, as the desktop row does', () => {
    renderFooter('/plan/tasks?includedEntityTypes=Content,File');

    const sheet = openFilters();

    expect(row(sheet, 'How')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /^Activity/ })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /^Who/ })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /^Where/ })).not.toBeInTheDocument();
  });

  it('turns the two toggles into switches on the same URL flags', () => {
    renderFooter('/plan/tasks?semantic=1');

    const sheet = openFilters();
    const located = within(sheet).getByRole('switch', { name: 'Only items with a place' });
    const meaning = within(sheet).getByRole('switch', { name: 'Match by meaning' });

    expect(located).toHaveAttribute('aria-checked', 'false');
    expect(meaning).toHaveAttribute('aria-checked', 'true');
    expect(
      within(sheet).getByText('Finds related memories even when they use different words.'),
    ).toBeVisible();

    fireEvent.click(located);
    expect(params().get('hasLocation')).toBe('1');

    fireEvent.click(meaning);
    expect(params().has('semantic')).toBe(false);
  });

  it('opens the dimension’s own picker from its row and writes the pick to the same param', async () => {
    renderFooter('/plan/tasks', {
      mocks: [
        OWN_SAVED_SEARCHES,
        mockQuery(SOURCE_SYSTEMS_QUERY, {}, { sourceSystems: ['gmail', 'reddit'] }),
      ],
    });

    const sheet = openFilters();

    fireEvent.click(row(sheet, 'How'));
    fireEvent.click(await screen.findByRole('option', { name: 'Gmail' }));

    expect(params().get('connectors')).toBe('gmail');

    // Escape closes the picker (the top layer) and leaves the sheet open.
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'How options' }), { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'How options' })).not.toBeInTheDocument(),
    );
    expect(row(sheet, 'How')).toHaveTextContent('Gmail');
  });

  it('shows the sort in force on the Sort row', () => {
    renderFooter('/plan/tasks?sortBy=time&sortOrder=desc');

    expect(within(openFilters()).getByRole('combobox')).toHaveTextContent(/Sort\s*Newest first/);
  });

  it('offers Clear all only while something is set, and hands it to the header', () => {
    const onClearFilters = vi.fn();
    const { unmount } = renderFooter('/plan/tasks', { onClearFilters });

    expect(within(openFilters()).queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
    unmount();

    renderFooter('/plan/tasks?sortBy=name&sortOrder=asc', { onClearFilters });
    fireEvent.click(within(openFilters()).getByRole('button', { name: 'Clear all' }));

    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('pins Save search, which opens the existing save dialog, and Done beside it', () => {
    renderFooter('/plan/tasks?people=Ada%20Lovelace');

    const sheet = openFilters();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Save search' }));
    expect(screen.getByRole('dialog', { name: 'Save this search' })).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Save this search' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));

    expect(screen.queryByRole('dialog', { name: 'Filters' })).not.toBeInTheDocument();
  });

  it('closes just the What menu on Escape, not the sheet under it', async () => {
    renderFooter('/plan/tasks');

    const sheet = openFilters();

    // Radix's menu trigger opens on pointerdown for mouse input.
    fireEvent.pointerDown(row(sheet, 'What'), { button: 0 });
    const menu = await screen.findByRole('menu');

    fireEvent.keyDown(menu, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
  });

  it('hands a picked saved search to the header to open, instead of applying it to a page with nothing to filter', async () => {
    const onOpenSavedSearch = vi.fn();

    renderFooter('/plan/tasks?view=board', {
      onOpenSavedSearch,
      mocks: [
        OWN_SAVED_SEARCHES,
        mockQuery(
          GetSavedSearchDocument,
          { id: TRIP_ID },
          {
            savedSearch: {
              __typename: 'SavedSearchType' as const,
              id: TRIP_ID,
              name: 'My trip',
              description: null,
              query: 'paris',
              entityTypes: [],
              tags: ['vacation'],
              filters: null,
            },
          },
        ),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^Saved searches\s*1/ }));

    const sheet = screen.getByRole('dialog', { name: 'Saved searches' });

    // No keyboard over the list on open: the filter box is not focused.
    expect(within(sheet).getByPlaceholderText('Filter your saved searches...')).not.toHaveFocus();

    fireEvent.click(await within(sheet).findByText('My trip'));

    await waitFor(() => expect(onOpenSavedSearch).toHaveBeenCalledTimes(1));
    const opened: URLSearchParams = onOpenSavedSearch.mock.calls[0][0];
    expect(opened.get('search')).toBe('paris');
    expect(opened.get('tags')).toBe('vacation');
    // The page's own params stay behind, and this page's URL is left alone.
    expect(opened.has('view')).toBe(false);
    expect(params().has('search')).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Saved searches' })).not.toBeInTheDocument(),
    );
  });
});
