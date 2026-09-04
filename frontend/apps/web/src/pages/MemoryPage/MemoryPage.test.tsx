import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

// The page body is irrelevant here — this spec is about what a bare
// `/memory` or `/memory/events` URL MEANS. Stub the data provider and the
// lazy views so rendering never reaches Apollo for the *page* data. The
// MockedProvider below is still required: useSavedSearchResolution's
// useQuery(GET_SAVED_SEARCH, { skip }) calls useApolloClient() even while
// skipped (no `?saved_search` param in any of these URLs), so it still needs
// an Apollo context to render at all.
vi.mock('./useEntityService', () => ({
  EntityServiceProvider: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ResponsiveLoader', () => ({
  ResponsiveLoader: () => <div data-testid="explorer-body" />,
}));

import { DEFAULT_MEMORY_EVENTS_SEARCH, DEFAULT_MEMORY_SEARCH, MemoryPage } from './MemoryPage';

function LocationProbe() {
  const location = useLocation();

  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function ExplorerRoute() {
  return (
    <>
      <MemoryPage />
      <LocationProbe />
    </>
  );
}

function renderAt(url: string) {
  return render(
    <MockedProvider mocks={[]}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/memory" element={<ExplorerRoute />} />
          <Route path="/memory/events" element={<ExplorerRoute />} />
        </Routes>
      </MemoryRouter>
    </MockedProvider>,
  );
}

describe('MemoryPage default filters', () => {
  it('redirects a bare /memory URL to the list view with no type filter', () => {
    renderAt('/memory');

    expect(screen.getByTestId('location')).toHaveTextContent(`/memory?${DEFAULT_MEMORY_SEARCH}`);
    expect(screen.getByTestId('explorer-body')).toBeInTheDocument();
  });

  it('redirects a bare /memory/events URL to the list view — the route itself scopes the kinds', () => {
    renderAt('/memory/events');

    expect(screen.getByTestId('location')).toHaveTextContent(
      `/memory/events?${DEFAULT_MEMORY_EVENTS_SEARCH}`,
    );
    expect(screen.getByTestId('explorer-body')).toBeInTheDocument();
  });

  it('leaves a search deep link alone — the global search must search everything', () => {
    renderAt('/memory/events?search=sunset');

    expect(screen.getByTestId('location')).toHaveTextContent('/memory/events?search=sunset');
  });

  it('leaves a tag deep link alone', () => {
    renderAt('/memory/events?tags=travel');

    expect(screen.getByTestId('location')).toHaveTextContent('/memory/events?tags=travel');
  });

  it('leaves an explicit view choice alone (the /memory/knowledge redirect)', () => {
    renderAt('/memory/events?view=graph');

    expect(screen.getByTestId('location')).toHaveTextContent('/memory/events?view=graph');
  });

  it('leaves the TimelineJS view choice alone', () => {
    renderAt('/memory/events?view=timeline');

    expect(screen.getByTestId('location')).toHaveTextContent('/memory/events?view=timeline');
  });
});

describe('MemoryPage time-sort reset', () => {
  it('drops a time sort from /memory once no When filter is active', () => {
    renderAt('/memory?view=list&sortBy=time&sortOrder=desc');

    expect(screen.getByTestId('location')).toHaveTextContent('/memory?view=list');
  });

  it('keeps a time sort on /memory while a When filter is active', () => {
    const url =
      '/memory?view=list&when=last-week&from=2026-01-01T00:00:00.000Z&to=2026-01-07T23:59:59.999Z&sortBy=time&sortOrder=asc';

    renderAt(url);

    expect(screen.getByTestId('location')).toHaveTextContent(url);
  });

  it('never touches the events browse, which is a chronology', () => {
    renderAt('/memory/events?view=list&sortBy=time&sortOrder=desc');

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/memory/events?view=list&sortBy=time&sortOrder=desc',
    );
  });

  it('walks a stale Timeline view on /memory back to List once no When filter is active', () => {
    renderAt('/memory?view=timeline&sortBy=time&sortOrder=desc');

    expect(screen.getByTestId('location')).toHaveTextContent('/memory?view=list');
  });

  it('keeps the Timeline view on /memory inside a When filter, and always on the events browse', () => {
    const inWindow = '/memory?view=timeline&when=last-week&from=2026-01-01T00:00:00.000Z&to=2026-01-07T23:59:59.999Z';

    renderAt(inWindow);
    expect(screen.getByTestId('location')).toHaveTextContent(inWindow);

    renderAt('/memory/events?view=timeline');
    expect(screen.getAllByTestId('location').at(-1)).toHaveTextContent('/memory/events?view=timeline');
  });

  it('leaves a name sort alone', () => {
    renderAt('/memory?view=list&sortBy=name&sortOrder=asc');

    expect(screen.getByTestId('location')).toHaveTextContent('/memory?view=list&sortBy=name&sortOrder=asc');
  });
});
