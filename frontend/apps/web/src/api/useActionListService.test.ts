/**
 * useActionListService: the feed's action list plus its two mutations (mark
 * seen / mark dismissed). Both mutations round-trip through a base64
 * `type:id` global id the query also has to decode back down to a bare id —
 * get either direction wrong and every action in the feed points nowhere.
 * useQuery/useMutation are mocked (per useRescheduleEvent.test.ts's pattern)
 * so this stays about the hook's own mapping and call wiring.
 */
import { useMutation, useQuery } from '@apollo/client/react';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useActionListService } from './useActionListService';

vi.mock('@apollo/client/react', async (orig) => ({
  ...(await orig<typeof import('@apollo/client/react')>()),
  useQuery: vi.fn(),
  useMutation: vi.fn(),
}));

const mockedUseQuery = vi.mocked(useQuery);
const mockedUseMutation = vi.mocked(useMutation);
const markAsSeen = vi.fn();
const markAsDismissed = vi.fn();
const refetch = vi.fn();

function setQueryResult(overrides: Partial<ReturnType<typeof useQuery>> = {}) {
  mockedUseQuery.mockReturnValue({
    data: undefined,
    loading: false,
    error: undefined,
    refetch,
    ...overrides,
  } as unknown as ReturnType<typeof useQuery>);
}

function node(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: btoa('action:41'),
    title: 'Reply to Jamie',
    text: 'Jamie asked about Thursday',
    imageUrl: null,
    priority: 2,
    seen: false,
    dismissed: false,
    metadata: { seen: false, type: 'reminder', context: null, relatedPerson: null },
    thread: { id: btoa('thread:9') },
    ...overrides,
  };
}

beforeEach(() => {
  markAsSeen.mockReset().mockResolvedValue({ data: {} });
  markAsDismissed.mockReset().mockResolvedValue({ data: {} });
  refetch.mockReset().mockResolvedValue({ data: {} });

  // The hook calls useMutation twice per render, always in this order
  // (seen, then dismissed) — cycle rather than queue "once" values so a test
  // that renders more than once (e.g. to compare two states) still gets both
  // mutate functions on every render, not undefined once the queue empties.
  let callIndex = 0;
  mockedUseMutation.mockImplementation(() => {
    const value = callIndex % 2 === 0 ? [markAsSeen, {}] : [markAsDismissed, {}];
    callIndex += 1;

    return value as unknown as ReturnType<typeof useMutation>;
  });

  setQueryResult();
});

describe('useActionListService — reading the feed', () => {
  it('decodes the global id on both the action and its thread', () => {
    setQueryResult({ data: { feedActions: [node()] } });

    const [{ data }] = renderHook(() => useActionListService()).result.current;

    expect(data[0].id).toBe('41');
    expect(data[0].threadId).toBe('9');
  });

  it('falls back to no threadId when the action has no thread', () => {
    setQueryResult({ data: { feedActions: [node({ thread: null })] } });

    const [{ data }] = renderHook(() => useActionListService()).result.current;

    expect(data[0].threadId).toBeUndefined();
  });

  it('maps null imageUrl/priority to undefined, and always starts with no tags', () => {
    setQueryResult({ data: { feedActions: [node({ imageUrl: null, priority: null })] } });

    const [{ data }] = renderHook(() => useActionListService()).result.current;

    expect(data[0].imageUrl).toBeUndefined();
    expect(data[0].priority).toBeUndefined();
    expect(data[0].tags).toEqual([]);
  });

  it('reports loading only before the first payload arrives, not during a background refetch', () => {
    // First load: no data yet.
    setQueryResult({ data: undefined, loading: true });
    expect(renderHook(() => useActionListService()).result.current[0].loading).toBe(true);

    // A refetch with data already in hand must not blank the feed to a spinner.
    setQueryResult({ data: { feedActions: [] }, loading: true });
    expect(renderHook(() => useActionListService()).result.current[0].loading).toBe(false);
  });

  it('forwards the limit and skip option to the query', () => {
    renderHook(() => useActionListService(10, { skip: true }));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ variables: { limit: 10 }, skip: true }),
    );
  });
});

describe('useActionListService — mutations', () => {
  it('encodes a bare action id into the action:<id> global id for markActionAsSeen', async () => {
    const [, { markActionAsSeen }] = renderHook(() => useActionListService()).result.current;

    await markActionAsSeen('41');

    expect(markAsSeen).toHaveBeenCalledWith({ variables: { id: btoa('action:41') } });
  });

  it('encodes the id for markActionAsDismissed, then refetches the list', async () => {
    const [, { markActionAsDismissed }] = renderHook(() => useActionListService()).result.current;

    await markActionAsDismissed('41');

    expect(markAsDismissed).toHaveBeenCalledWith({ variables: { id: btoa('action:41') } });
    expect(refetch).toHaveBeenCalled();
  });

  it('does not refetch when the dismiss mutation itself fails', async () => {
    markAsDismissed.mockRejectedValueOnce(new Error('server error'));
    const [, { markActionAsDismissed }] = renderHook(() => useActionListService()).result.current;

    await expect(markActionAsDismissed('41')).rejects.toThrow('server error');
    expect(refetch).not.toHaveBeenCalled();
  });
});
