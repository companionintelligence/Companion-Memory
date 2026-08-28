import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogueEntry, CataloguePage } from './catalogue';
import { useReflectionCatalogue } from './useReflectionCatalogue';

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'tok', expired: false, loading: false, error: null }, {}],
}));

function entry(overrides: Partial<CatalogueEntry> = {}): CatalogueEntry {
  return {
    id: 'q1',
    key: null,
    text: 'What foods are you allergic to?',
    category: 'Health & Body',
    answerTier: 'factual',
    questionType: 'open_ended',
    frequencyRecommendation: null,
    isActive: true,
    isSeedQuestion: true,
    createdByLlm: false,
    isPrivateTo: null,
    forkedFromQuestionId: null,
    timesAsked: 0,
    timesAnswered: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    answer: null,
    ...overrides,
  };
}

function pageOf(data: CatalogueEntry[], overrides: Partial<CataloguePage> = {}): CataloguePage {
  return {
    data,
    totalCount: data.length,
    limit: 25,
    offset: 0,
    facets: { categories: [], answerTiers: [], answeredCount: 0, unansweredCount: data.length },
    ...overrides,
  };
}

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

function setFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal('fetch', mock);

  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe('useReflectionCatalogue', () => {
  it('loads the active page on mount', async () => {
    const fetchMock = setFetch(() => ok(pageOf([entry()])));

    const { result } = renderHook(() => useReflectionCatalogue());

    await waitFor(() => expect(result.current[0].page?.data).toHaveLength(1));
    expect(result.current[0].loading).toBe(false);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/questions/catalogue?status=active');
  });

  it('resets the offset when a filter changes, so a filtered list is never a blank page 12', async () => {
    setFetch(() => ok(pageOf([entry()], { totalCount: 200 })));

    const { result } = renderHook(() => useReflectionCatalogue());
    await waitFor(() => expect(result.current[0].page).not.toBeNull());

    act(() => result.current[1].goToPage(150));
    await waitFor(() => expect(result.current[0].filters.offset).toBe(150));

    act(() => result.current[1].setCategory('Work & Money'));

    await waitFor(() => expect(result.current[0].filters.offset).toBe(0));
    expect(result.current[0].filters.category).toBe('Work & Money');
  });

  it('debounces the search box instead of spending a request per keystroke', async () => {
    const fetchMock = setFetch(() => ok(pageOf([entry()])));

    const { result } = renderHook(() => useReflectionCatalogue());
    await waitFor(() => expect(result.current[0].page).not.toBeNull());
    const initialCalls = fetchMock.mock.calls.length;

    act(() => result.current[1].setSearch('a'));
    act(() => result.current[1].setSearch('al'));
    act(() => result.current[1].setSearch('all'));

    // The box updates immediately; the request has not gone out yet.
    expect(result.current[0].searchInput).toBe('all');
    expect(fetchMock.mock.calls.length).toBe(initialCalls);

    await waitFor(() => expect(result.current[0].filters.search).toBe('all'));
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('search=all'));
  });

  it('deactivates through PATCH isActive — never DELETE, which would cascade answers away', async () => {
    const fetchMock = setFetch((_url, init) => {
      if (init?.method === 'PATCH') {
        return ok({});
      }

      return ok(pageOf([entry()]));
    });

    const { result } = renderHook(() => useReflectionCatalogue());
    await waitFor(() => expect(result.current[0].page).not.toBeNull());

    await act(async () => {
      await result.current[1].setActive('q1', false);
    });

    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(String(patch?.[0])).toContain('/api/questions/q1');
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ isActive: false });
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'DELETE')).toBe(false);
  });

  it('re-fetches after a write so facet counts stay honest', async () => {
    const fetchMock = setFetch((_url, init) => (init?.method === 'PATCH' ? ok({}) : ok(pageOf([entry()]))));

    const { result } = renderHook(() => useReflectionCatalogue());
    await waitFor(() => expect(result.current[0].page).not.toBeNull());
    const gets = () => fetchMock.mock.calls.filter(([, init]) => !(init as RequestInit)?.method).length;
    const before = gets();

    await act(async () => {
      await result.current[1].update('q1', { text: 'Reworded', category: null, answerTier: null });
    });

    await waitFor(() => expect(gets()).toBeGreaterThan(before));
  });

  it('creates through POST /api/questions', async () => {
    const fetchMock = setFetch((_url, init) => (init?.method === 'POST' ? ok({}) : ok(pageOf([]))));

    const { result } = renderHook(() => useReflectionCatalogue());
    await waitFor(() => expect(result.current[0].page).not.toBeNull());

    await act(async () => {
      await result.current[1].create({
        text: 'What is your shoe size?',
        category: 'Health & Body',
        answerTier: 'factual',
      });
    });

    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    expect(String(post?.[0])).toContain('/api/questions');
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
      text: 'What is your shoe size?',
      category: 'Health & Body',
      answerTier: 'factual',
    });
  });

  it('surfaces a load failure instead of spinning forever', async () => {
    setFetch(() => ({ ok: false, status: 500, statusText: 'Server Error' }) as Response);

    const { result } = renderHook(() => useReflectionCatalogue());

    await waitFor(() => expect(result.current[0].error).not.toBeNull());
    expect(result.current[0].loading).toBe(false);
  });

  it('rejects — rather than silently swallowing — a failed write', async () => {
    setFetch((_url, init) =>
      init?.method === 'PATCH'
        ? ({ ok: false, status: 403, statusText: 'Forbidden' } as Response)
        : ok(pageOf([entry()])),
    );

    const { result } = renderHook(() => useReflectionCatalogue());
    await waitFor(() => expect(result.current[0].page).not.toBeNull());

    await act(async () => {
      await expect(result.current[1].setActive('q1', false)).rejects.toThrow();
    });

    expect(result.current[0].savingId).toBeNull();
  });
});
