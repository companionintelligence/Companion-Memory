/**
 * useTagEntityService: tag/untag entities, then evict the cached root `tags`
 * list so the explorer's tag-filter autocomplete (and anything else reading
 * ROOT_QUERY.tags) sees a freshly-created or now-orphaned tag. useMutation is
 * mocked (per useRescheduleEvent.test.ts's pattern) so the `update` callback
 * — the part with real cache-eviction logic — can be invoked directly against
 * a fake cache.
 */
import { useMutation } from '@apollo/client/react';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTagEntityService } from './useTagEntityService';

vi.mock('@apollo/client/react', async (orig) => ({
  ...(await orig<typeof import('@apollo/client/react')>()),
  useMutation: vi.fn(),
}));

const mockedUseMutation = vi.mocked(useMutation);
const tagMutate = vi.fn();
const untagMutate = vi.fn();

function fakeCache() {
  return { evict: vi.fn(), gc: vi.fn() };
}

beforeEach(() => {
  tagMutate.mockReset().mockResolvedValue({ data: { tagEntities: [{ id: 'e1', tags: [] }] } });
  untagMutate.mockReset().mockResolvedValue({ data: { untagEntities: [{ id: 'e1', tags: [] }] } });
  // useTagEntityService calls useMutation(TAG_ENTITIES) then useMutation(UNTAG_ENTITIES), in order.
  mockedUseMutation
    .mockReturnValueOnce([tagMutate, {}] as unknown as ReturnType<typeof useMutation>)
    .mockReturnValueOnce([untagMutate, {}] as unknown as ReturnType<typeof useMutation>);
});

describe('useTagEntityService.tagEntities', () => {
  it('sends every id with every label in one mutation', async () => {
    const { result } = renderHook(() => useTagEntityService());

    await result.current.tagEntities(['e1', 'e2'], ['vacation']);

    expect(tagMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: { input: { ids: ['e1', 'e2'], labels: ['vacation'] } },
      }),
    );
  });

  it('evicts the cached tags list on a successful tag, so a new tag reaches autocomplete', async () => {
    const { result } = renderHook(() => useTagEntityService());
    await result.current.tagEntities(['e1'], ['vacation']);

    const update = tagMutate.mock.calls[0][0].update as (cache: unknown, res: unknown) => void;
    const cache = fakeCache();

    update(cache, { data: { tagEntities: [{ id: 'e1', tags: [{ id: 't1', label: 'vacation' }] }] } });

    expect(cache.evict).toHaveBeenCalledWith({ id: 'ROOT_QUERY', fieldName: 'tags' });
    expect(cache.gc).toHaveBeenCalled();
  });

  it('does not touch the cache when the mutation came back with no data', async () => {
    // A rejected write (e.g. GraphQL error surfaced as null data rather than a
    // thrown exception) must not evict a cache entry as if something changed.
    const { result } = renderHook(() => useTagEntityService());
    await result.current.tagEntities(['e1'], ['vacation']);

    const update = tagMutate.mock.calls[0][0].update as (cache: unknown, res: unknown) => void;
    const cache = fakeCache();

    update(cache, { data: undefined });

    expect(cache.evict).not.toHaveBeenCalled();
    expect(cache.gc).not.toHaveBeenCalled();
  });

  it('rejects rather than swallowing a failed tag mutation', async () => {
    tagMutate.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useTagEntityService());

    await expect(result.current.tagEntities(['e1'], ['vacation'])).rejects.toThrow('network down');
  });
});

describe('useTagEntityService.untagEntities', () => {
  it('sends every id with every label in one mutation', async () => {
    const { result } = renderHook(() => useTagEntityService());

    await result.current.untagEntities(['e1'], ['vacation', 'work']);

    expect(untagMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: { input: { ids: ['e1'], labels: ['vacation', 'work'] } },
      }),
    );
  });

  it('evicts the cached tags list unconditionally, so an orphaned tag drops out of suggestions', async () => {
    const { result } = renderHook(() => useTagEntityService());
    await result.current.untagEntities(['e1'], ['vacation']);

    const update = untagMutate.mock.calls[0][0].update as (cache: unknown) => void;
    const cache = fakeCache();

    // No `data` argument passed at all here — untag's eviction does not
    // gate on it the way tag's does.
    update(cache);

    expect(cache.evict).toHaveBeenCalledWith({ id: 'ROOT_QUERY', fieldName: 'tags' });
    expect(cache.gc).toHaveBeenCalled();
  });

  it('rejects rather than swallowing a failed untag mutation', async () => {
    untagMutate.mockRejectedValueOnce(new Error('server error'));
    const { result } = renderHook(() => useTagEntityService());

    await expect(result.current.untagEntities(['e1'], ['vacation'])).rejects.toThrow('server error');
  });
});
