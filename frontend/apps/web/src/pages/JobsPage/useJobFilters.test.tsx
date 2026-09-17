import type { ReactNode } from 'react';

import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { useHistoryWindow, useJobFilters } from './useJobFilters';

/**
 * The query string is the page's state, so these are the tests that decide
 * whether a link is a place. They run against a MemoryRouter, which is the only
 * thing in the harness that actually has a location.
 */
function wrapper(initial: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>;
  };
}

function useProbe(limit = 50) {
  return { filters: useJobFilters(limit), location: useLocation() };
}

describe('useJobFilters', () => {
  it('reads every filter out of the query string', () => {
    const { result } = renderHook(() => useProbe(), {
      wrapper: wrapper(
        '/jobs?state=failed&category=llm&type=chat.generate&queue=llm&search=ffmpeg&offset=50',
      ),
    });

    expect(result.current.filters.filters).toMatchObject({
      state: 'failed',
      category: 'llm',
      type: 'chat.generate',
      queue: 'llm',
      search: 'ffmpeg',
      offset: 50,
    });
    expect(result.current.filters.isFiltered).toBe(true);
  });

  it('writes only what was chosen, so a bare /jobs means no filters', () => {
    const { result } = renderHook(() => useProbe(), { wrapper: wrapper('/jobs') });

    act(() => result.current.filters.setFilters({ state: 'failed' }));

    // Not `state=failed&category=&type=&queue=&search=&offset=0`: a URL carrying
    // every default is unreadable and makes "am I filtered?" unanswerable at a
    // glance.
    expect(result.current.location.search).toBe('?state=failed');
    expect(result.current.filters.isFiltered).toBe(true);
  });

  it('keeps the page size out of the URL', () => {
    // `limit` is a property of the DEVICE, not the view — a phone-sized link
    // opened on a desktop must not stay phone-sized.
    const { result } = renderHook(() => useProbe(20), { wrapper: wrapper('/jobs?state=failed') });

    act(() => result.current.filters.setFilters({ queue: 'llm' }));

    expect(result.current.location.search).not.toContain('limit');
    expect(result.current.filters.filters.limit).toBe(20);
  });

  it('lets the category ROUTE win over the query string', () => {
    // `/jobs/category/ingest` names the category in the path. Without a
    // precedence rule the two would fight on the first render and one would
    // silently lose.
    const { result } = renderHook(() => useProbe(), {
      wrapper: wrapper('/jobs/category/ingest?category=llm'),
    });

    expect(result.current.filters.filters.category).toBe('ingest');
  });

  // ── The category route: the path owns the category ──────────────────────
  //
  // These are the regression. On /jobs/category/:category the chips used to
  // write `?category=`, which the path then overrode on the next render — so
  // the whole category row plus Clear were dead controls on ten rail
  // destinations, and the address bar ended up self-contradicting.

  it('navigates when the category changes on a category route', () => {
    const { result } = renderHook(() => useProbe(), {
      wrapper: wrapper('/jobs/category/ingest?state=failed'),
    });

    act(() => result.current.filters.setFilters({ category: 'llm', type: '' }));

    expect(result.current.location.pathname).toBe('/jobs/category/llm');
    expect(result.current.filters.filters.category).toBe('llm');
    // Other filters are carried, not silently dropped.
    expect(result.current.location.search).toContain('state=failed');
  });

  it('the All chip leaves the category route entirely', () => {
    const { result } = renderHook(() => useProbe(), {
      wrapper: wrapper('/jobs/category/ingest?state=failed'),
    });

    act(() => result.current.filters.setFilters({ category: '', type: '' }));

    expect(result.current.location.pathname).toBe('/jobs');
    expect(result.current.filters.filters.category).toBe('');
    expect(result.current.location.search).toContain('state=failed');
  });

  it('clear() leaves a category route, instead of stripping everything except the category', () => {
    const { result } = renderHook(() => useProbe(), {
      wrapper: wrapper('/jobs/category/ingest?state=failed&search=boom'),
    });

    act(() => result.current.filters.clear());

    expect(result.current.location.pathname).toBe('/jobs');
    expect(result.current.location.search).toBe('');
    expect(result.current.filters.isFiltered).toBe(false);
  });

  it('still writes the query string when NOT on a category route', () => {
    const { result } = renderHook(() => useProbe(), { wrapper: wrapper('/jobs') });

    act(() => result.current.filters.setFilters({ category: 'llm' }));

    expect(result.current.location.pathname).toBe('/jobs');
    expect(result.current.location.search).toBe('?category=llm');
  });

  it('clear() drops the filters and leaves the route alone', () => {
    const { result } = renderHook(() => useProbe(), {
      wrapper: wrapper('/jobs?state=failed&category=llm'),
    });

    act(() => result.current.filters.clear());

    expect(result.current.location.search).toBe('');
    expect(result.current.location.pathname).toBe('/jobs');
    expect(result.current.filters.isFiltered).toBe(false);
  });

  it('drops a filter from the URL when it is set back to empty', () => {
    const { result } = renderHook(() => useProbe(), { wrapper: wrapper('/jobs?state=failed&category=llm') });

    act(() => result.current.filters.setFilters({ category: '' }));

    expect(result.current.location.search).toBe('?state=failed');
  });
});

describe('useHistoryWindow', () => {
  it('defaults without writing itself into the URL', () => {
    const { result } = renderHook(() => ({ window: useHistoryWindow(24), location: useLocation() }), {
      wrapper: wrapper('/jobs'),
    });

    expect(result.current.window[0]).toBe(24);
    expect(result.current.location.search).toBe('');
  });

  it('carries a chosen range so a shared chart shows the same window', () => {
    const { result } = renderHook(() => ({ window: useHistoryWindow(24), location: useLocation() }), {
      wrapper: wrapper('/jobs'),
    });

    act(() => result.current.window[1](168));

    expect(result.current.window[0]).toBe(168);
    expect(result.current.location.search).toBe('?hours=168');
  });
});
