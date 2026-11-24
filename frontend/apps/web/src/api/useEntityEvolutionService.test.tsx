import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useEntityEvolutionService } from './useEntityEvolutionService';

vi.mock('@/hooks', () => ({ useAuth: () => [{ authToken: 'token' }] }));

const ENTITY_ID = '019fdcb3-b482-7101-af89-264466bf95ff';

function mockFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, data: { entityId: ENTITY_ID, deltas: [], stats: {} } }),
  }));
  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

describe('useEntityEvolutionService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches once on mount and again when refreshKey changes', async () => {
    const fetchMock = mockFetch();
    const { rerender } = renderHook((props) => useEntityEvolutionService(props), {
      initialProps: { entityId: ENTITY_ID, refreshKey: 0 },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ entityId: ENTITY_ID, refreshKey: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ entityId: ENTITY_ID, refreshKey: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
