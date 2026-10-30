import type { ReactNode } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntityResultList } from './EntityResultList';

const ROWS = Array.from({ length: 40 }, (_, index) => ({
  __typename: 'EventType' as const,
  id: `event-${index}`,
  startTime: '2026-10-22T12:00:00.000Z',
}));

const h = vi.hoisted(() => ({ service: {} as Record<string, unknown> }));

/** What the list's service hands back on its next render. */
function serve({ rows = 40, loading = false, hasNextPage = false, nameSortCutShort = false } = {}) {
  h.service = {
    data: ROWS.slice(0, rows),
    loading,
    hasNextPage,
    loadingMore: false,
    loadMore: () => {},
    error: undefined,
    refetch: () => {},
    totalCount: ROWS.length,
    nameSortCutShort,
  };
}

vi.mock('../useEntityService', () => ({
  useEntityService: () => [h.service, { setActiveEntity: () => {} }],
}));

vi.mock('./rows/EventRow', () => ({
  EventRow: ({ event }: { event: { id: string } }) => <div data-row="">{event.id}</div>,
}));

vi.mock('@/components/ChatWithAgent', () => ({
  MemoryChatAbout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const ROW_HEIGHT = 50;
const VIEWPORT_HEIGHT = 500;
const PATCHED = ['scrollHeight', 'clientHeight', 'scrollTop'] as const;
const originals = PATCHED.map((property) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, property));

const maxScrollTop = (el: HTMLElement) =>
  Math.max(0, el.querySelectorAll('[data-row]').length * ROW_HEIGHT - VIEWPORT_HEIGHT);

// jsdom does no layout. Each row is 50px in a 500px box. The box clamps
// scrollTop to what the rows can hold the way a browser does, also when the
// rows shrink under it.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.querySelectorAll('[data-row]').length * ROW_HEIGHT;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT_HEIGHT,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement & { _top?: number }) {
      this._top = Math.min(this._top ?? 0, maxScrollTop(this));

      return this._top;
    },
    set(this: HTMLElement & { _top?: number }, value: number) {
      this._top = Math.max(0, Math.min(value, maxScrollTop(this)));
    },
  });
});

afterAll(() => {
  PATCHED.forEach((property, index) => {
    const descriptor = originals[index];

    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, property, descriptor);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
    }
  });
});

beforeEach(() => serve());

let navigate: ReturnType<typeof useNavigate>;

function NavigateHandle() {
  navigate = useNavigate();

  return null;
}

// Every render starts on its own history entry. Otherwise MemoryRouter keys
// each first entry "default", which a position saved by an earlier test
// still answers to.
let visit = 0;

function renderList() {
  visit += 1;
  const entry = { pathname: '/memory/events', search: '?view=list', key: `list-visit-${visit}` };
  const ui = () => (
    <MemoryRouter initialEntries={[entry]}>
      <NavigateHandle />
      <Routes>
        <Route path="/memory/events" element={<EntityResultList grouped={false} emptyState={null} />} />
        <Route path="/events/:id" element={<p>Full page</p>} />
      </Routes>
    </MemoryRouter>
  );
  const result = render(ui());

  return { rerender: () => result.rerender(ui()) };
}

const scrollBox = () => document.querySelector<HTMLElement>('[data-list-scroll]')!;

function scrollTo(top: number) {
  scrollBox().scrollTop = top;
  fireEvent.scroll(scrollBox());
}

describe('EntityResultList', () => {
  it('puts the list back where it was on Back from a full page', () => {
    renderList();
    scrollTo(600);

    act(() => navigate('/events/event-12'));
    expect(screen.getByText('Full page')).toBeInTheDocument();

    act(() => navigate(-1));
    expect(scrollBox().scrollTop).toBe(600);
  });

  it('opens a new visit to the list at the top', () => {
    renderList();
    scrollTo(600);

    act(() => navigate('/events/event-12'));
    // A fresh history entry for the list, not Back to the old one.
    act(() => navigate('/memory/events?view=list'));

    expect(scrollBox().scrollTop).toBe(0);
  });

  it('keeps restoring through the refetch that follows Back', () => {
    const list = renderList();
    scrollTo(1200);

    act(() => navigate('/events/event-30'));

    // The cache answers with all 40 rows while page one is fetched again.
    serve({ rows: 40, loading: true, hasNextPage: true });
    act(() => navigate(-1));
    expect(scrollBox().scrollTop).toBe(1200);

    // Page one replaces them, so the box is too short for the position.
    serve({ rows: 20, hasNextPage: true });
    list.rerender();
    expect(scrollBox().scrollTop).toBe(500);

    // The next page makes room for it again.
    serve({ rows: 40 });
    list.rerender();
    expect(scrollBox().scrollTop).toBe(1200);
  });

  it('stops restoring once the reader scrolls', () => {
    const list = renderList();
    scrollTo(1200);

    act(() => navigate('/events/event-30'));

    serve({ rows: 20, hasNextPage: true });
    act(() => navigate(-1));
    expect(scrollBox().scrollTop).toBe(500);

    fireEvent.wheel(scrollBox());
    scrollTo(100);

    serve({ rows: 40 });
    list.rerender();
    expect(scrollBox().scrollTop).toBe(100);
  });

  it('saves where the box is after a reload of the results moved it', () => {
    const list = renderList();
    scrollTo(1200);

    // The rows go while new results load. A browser clamps the box and fires
    // a scroll event at the skeleton.
    serve({ rows: 0, loading: true });
    list.rerender();
    fireEvent.scroll(scrollBox());

    serve({ rows: 40 });
    list.rerender();

    act(() => navigate('/events/event-0'));
    act(() => navigate(-1));
    expect(scrollBox().scrollTop).toBe(0);
  });

  it('says above the rows that a name sort left older ones out', () => {
    serve({ nameSortCutShort: true });
    renderList();

    const note = screen.getByTestId('name-sort-cut-short');

    expect(note).toHaveTextContent(
      'Sorted by name from the newest 500 of each kind, so older ones are not in this list. Pick dates under When, or search, to find them.',
    );
    // Above the first row, where the rows it is about start.
    expect(
      note.compareDocumentPosition(screen.getByText('event-0')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('says nothing about it when the list is whole', () => {
    renderList();

    expect(screen.getByText('event-0')).toBeInTheDocument();
    expect(screen.queryByTestId('name-sort-cut-short')).not.toBeInTheDocument();
  });
});
