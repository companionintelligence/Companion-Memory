import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGraphDots } from './useGraphDots';

/**
 * The Graph tab opens with `/api/graph/context` (who is "you") and
 * `/api/graph/dots` (the constellation) side by side. The context endpoint
 * answers `{ success: true, context: null }` for an account with no self Person,
 * and the hook used to turn that into the red "Unable to resolve user context"
 * across the whole canvas — QA MEM-16.
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const DOTS = {
  success: true,
  data: {
    nodes: [
      { id: 'n-1', entity_id: 'n-1', entity_type: 'PersonType', name: 'Ada Lovelace', degree: 2 },
      { id: 'n-2', entity_id: 'n-2', entity_type: 'PlaceType', name: 'London', degree: 1 },
    ],
  },
  counts: { PersonType: 1, PlaceType: 1 },
};

function serve(context: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/api/graph/context')) {
        return json(context);
      }

      if (url.includes('/api/graph/dots')) {
        return json(DOTS);
      }

      throw new Error(`Unexpected request: ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useGraphDots', () => {
  it('draws the constellation, uncentred, for an account with no self person', async () => {
    serve({ success: true, context: null });

    const { result } = renderHook(() => useGraphDots(null));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.nodes.map((node) => node.id)).toEqual(['n-1', 'n-2']);
    // Nobody to centre on — which is what `centerNodeId` already accepts.
    expect(result.current.userEntityId).toBeNull();
  });

  it('still centres on the account holder when there is a self person', async () => {
    serve({
      success: true,
      context: { currentUser: { entityId: 'n-1', name: 'Ada Lovelace', username: 'ada' } },
    });

    const { result } = renderHook(() => useGraphDots(null));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.userEntityId).toBe('n-1');
  });

  it('still reports a context request the server refused outright', async () => {
    serve({ success: false, context: null });

    const { result } = renderHook(() => useGraphDots(null));

    await waitFor(() => expect(result.current.error).toBe('Unable to resolve user context'));

    expect(result.current.nodes).toEqual([]);
  });
});
