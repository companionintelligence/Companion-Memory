import type { ReactNode } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { EntityResultList } from './EntityResultList';

const ROWS = Array.from({ length: 40 }, (_, index) => ({
  __typename: 'EventType' as const,
  id: `event-${index}`,
  startTime: '2026-10-22T12:00:00.000Z',
}));

vi.mock('../useEntityService', () => ({
  useEntityService: () => [
    {
      data: ROWS,
      loading: false,
      hasNextPage: false,
      loadingMore: false,
      loadMore: vi.fn(),
      error: undefined,
      refetch: vi.fn(),
      totalCount: ROWS.length,
    },
    { setActiveEntity: vi.fn() },
  ],
}));

vi.mock('./rows/EventRow', () => ({
  EventRow: ({ event }: { event: { id: string } }) => <div style={{ height: 50 }}>{event.id}</div>,
}));

vi.mock('@/components/ChatWithAgent', () => ({
  MemoryChatAbout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// jsdom does no layout: give every scroll box a height to scroll through and
// let scrollTop keep what it is set to, clamped the way a browser clamps it.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement & { _top?: number }) {
      return this._top ?? 0;
    },
    set(this: HTMLElement & { _top?: number }, value: number) {
      this._top = Math.max(0, Math.min(value, 1500));
    },
  });
});

let navigate: ReturnType<typeof useNavigate>;

function NavigateHandle() {
  navigate = useNavigate();

  return null;
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/memory/events?view=list']}>
      <NavigateHandle />
      <Routes>
        <Route path="/memory/events" element={<EntityResultList grouped={false} emptyState={null} />} />
        <Route path="/events/:id" element={<p>Full page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const scrollBox = () => document.querySelector<HTMLElement>('[data-list-scroll]')!;

describe('EntityResultList', () => {
  it('puts the list back where it was on Back from a full page', () => {
    renderList();

    scrollBox().scrollTop = 600;
    fireEvent.scroll(scrollBox());

    act(() => navigate('/events/event-12'));
    expect(screen.getByText('Full page')).toBeInTheDocument();

    act(() => navigate(-1));
    expect(scrollBox().scrollTop).toBe(600);
  });

  it('opens a new visit to the list at the top', () => {
    renderList();

    scrollBox().scrollTop = 600;
    fireEvent.scroll(scrollBox());

    act(() => navigate('/events/event-12'));
    // A fresh history entry for the list, not Back to the old one.
    act(() => navigate('/memory/events?view=list'));

    expect(scrollBox().scrollTop).toBe(0);
  });
});
