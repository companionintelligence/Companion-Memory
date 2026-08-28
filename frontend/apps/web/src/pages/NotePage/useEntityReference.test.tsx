import { GlobalUID } from '@ci/common';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEntityReference } from './useEntityReference';

/**
 * The `[[` picker's app-side half: which search results become reference
 * candidates, what they are labelled, and where a chip routes to. The label
 * lives behind a different alias per union member, so a wrong or missing one
 * shows up here as a candidate that silently disappears from the menu.
 */

const navigate = vi.fn();
const query = vi.fn();

// Stable, like the real `useApolloClient()` — the hook's memoization keys off
// the client identity, so a fresh stub per render would fake a rebuild.
const CLIENT = { query };

vi.mock('react-router-dom', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();

  return { ...original, useNavigate: () => navigate };
});

vi.mock('@apollo/client', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();

  return { ...original, useApolloClient: () => CLIENT };
});

function uid(type: Parameters<typeof GlobalUID.encode>[0], id: string) {
  return GlobalUID.encode(type, id);
}

function results(nodes: Record<string, unknown>[]) {
  return { data: { search: { edges: nodes.map((node) => ({ node })) } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue(results([]));
});

describe('useEntityReference — search', () => {
  it('does not hit the API for an empty query', async () => {
    const { result } = renderHook(() => useEntityReference());

    await expect(result.current.reference.search('   ')).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('asks for exactly the eight referenceable types', async () => {
    const { result } = renderHook(() => useEntityReference());

    await result.current.reference.search('  rey  ');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatchObject({
      variables: {
        query: 'rey',
        includeTypes: ['note', 'person', 'place', 'event', 'concept', 'item', 'content', 'communication'],
      },
    });
  });

  it('labels each entity type from its own aliased field', async () => {
    query.mockResolvedValue(
      results([
        { id: uid('note', 'n1'), referenceTitle: 'Weekly review' },
        { id: uid('person', 'p1'), referenceName: 'Rajaa Asad' },
        { id: uid('place', 'pl1'), placeReferenceName: 'Reykjavík' },
        { id: uid('concept', 'c1'), conceptReferenceName: 'Retrieval augmentation' },
        { id: uid('item', 'i1'), itemReferenceName: 'Framework 13' },
        { id: uid('event', 'e1'), eventReferenceTitle: 'Team offsite' },
        { id: uid('content', 'co1'), contentReferenceTitle: 'Q3 deck' },
        { id: uid('communication', 'cm1'), referencePreview: 'see you at 6' },
      ]),
    );

    const { result } = renderHook(() => useEntityReference());
    const items = await result.current.reference.search('a');

    expect(items.map((item) => [item.type, item.label])).toEqual([
      ['note', 'Weekly review'],
      ['person', 'Rajaa Asad'],
      ['place', 'Reykjavík'],
      ['concept', 'Retrieval augmentation'],
      ['item', 'Framework 13'],
      ['event', 'Team offsite'],
      ['content', 'Q3 deck'],
      ['communication', 'see you at 6'],
    ]);
  });

  it('drops results that would insert a chip going nowhere', async () => {
    query.mockResolvedValue(
      results([
        // No usable name.
        { id: uid('person', 'p1'), referenceName: '   ' },
        { id: uid('note', 'n1') },
        // A type with no detail route.
        { id: uid('file', 'f1'), referenceTitle: 'scan.pdf' },
        // Not a GlobalUID at all.
        { id: 'not-base64-at-all!!', referenceTitle: 'junk' },
        // Keeps its place.
        { id: uid('place', 'pl1'), placeReferenceName: 'Reykjavík' },
      ]),
    );

    const { result } = renderHook(() => useEntityReference());
    const items = await result.current.reference.search('r');

    expect(items).toEqual([{ uid: uid('place', 'pl1'), type: 'place', label: 'Reykjavík' }]);
  });

  it('caps the menu at eight candidates', async () => {
    query.mockResolvedValue(
      results(
        Array.from({ length: 20 }, (_, index) => ({
          id: uid('note', `n${index}`),
          referenceTitle: `Note ${index}`,
        })),
      ),
    );

    const { result } = renderHook(() => useEntityReference());

    await expect(result.current.reference.search('n')).resolves.toHaveLength(8);
  });

  it('shows the empty state rather than throwing when the lookup fails', async () => {
    query.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useEntityReference());

    await expect(result.current.reference.search('anything')).resolves.toEqual([]);
  });
});

describe('useEntityReference — routing', () => {
  it('resolves a detail route per type', () => {
    const { result } = renderHook(() => useEntityReference());
    const { resolveHref } = result.current.reference;

    expect(resolveHref({ uid: uid('note', 'n1'), type: 'note' })).toBe('/notes/n1');
    expect(resolveHref({ uid: uid('person', 'p1'), type: 'person' })).toBe('/people/p1');
    expect(resolveHref({ uid: uid('place', 'pl1'), type: 'place' })).toBe('/places/pl1');
    expect(resolveHref({ uid: uid('event', 'e1'), type: 'event' })).toBe('/events/e1');
    expect(resolveHref({ uid: uid('concept', 'c1'), type: 'concept' })).toBe('/concepts/c1');
    expect(resolveHref({ uid: uid('item', 'i1'), type: 'item' })).toBe('/items/i1');
    expect(resolveHref({ uid: uid('content', 'co1'), type: 'content' })).toBe('/content/co1');
    expect(resolveHref({ uid: uid('communication', 'cm1'), type: 'communication' })).toBe(
      '/communications/cm1',
    );
  });

  it('falls back to # for an unroutable type or an unreadable uid', () => {
    const { result } = renderHook(() => useEntityReference());
    const { resolveHref } = result.current.reference;

    expect(resolveHref({ uid: uid('file', 'f1'), type: 'file' })).toBe('#');
    expect(resolveHref({ uid: 'nonsense!!', type: 'note' })).toBe('#');
  });

  it('navigates on click, and stays put when there is nowhere to go', () => {
    const { result } = renderHook(() => useEntityReference());

    result.current.onReferenceClick({ uid: uid('person', 'p1'), type: 'person' });
    expect(navigate).toHaveBeenCalledWith('/people/p1');

    navigate.mockClear();
    result.current.onReferenceClick({ uid: uid('file', 'f1'), type: 'file' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps the config referentially stable so the editor is not rebuilt', () => {
    const { result, rerender } = renderHook(() => useEntityReference());
    const first = result.current.reference;

    rerender();

    expect(result.current.reference).toBe(first);
  });
});
