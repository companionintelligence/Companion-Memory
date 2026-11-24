import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGraphOverview } from './useGraphOverview';

/**
 * The classic `/api/graph/data` overview is what the Graph tab falls back to as
 * soon as a restrictive explorer filter is on. It needs "you" only as the root
 * of its depth-limited walk, and an account with no self Person has none — the
 * context endpoint answers `{ success: true, context: null }`. That used to
 * surface as a red "Unable to resolve user context" over the canvas (QA MEM-16).
 */

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const node = (id: string) => ({
  id,
  entity_id: id,
  entity_type: 'PersonType',
  name: id,
  description: null,
  properties: {},
});

const link = (id: string, source: string, target: string) => ({
  id,
  relationship_id: id,
  source,
  target,
  relationship_type: 'KNOWS',
  strength: 1,
  properties: {},
});

// a — b — c — d: three hops from `a` to `d`.
const GRAPH = {
  success: true,
  data: {
    nodes: ['a', 'b', 'c', 'd'].map(node),
    links: [link('ab', 'a', 'b'), link('bc', 'b', 'c'), link('cd', 'c', 'd')],
  },
};

function serve(context: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/api/graph/context')) {
        return json(context);
      }

      if (url.includes('/api/graph/data')) {
        return json(GRAPH);
      }

      throw new Error(`Unexpected request: ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useGraphOverview', () => {
  it('hands the graph through unpruned and uncentred for an account with no self person', async () => {
    serve({ success: true, context: null });

    const { result } = renderHook(() => useGraphOverview(null, { maxDepth: 1 }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    // No seed to walk out from, so nothing is pruned away: `d` is three hops
    // from `a` and would not survive a one-hop walk from anyone.
    expect(result.current.subgraph?.nodes.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.current.userEntityId).toBeNull();
    expect(result.current.currentUser).toBeNull();
    expect(result.current.quickStats).toBeNull();
  });

  it('still walks out from the account holder, to the depth asked for, when there is a self person', async () => {
    serve({
      success: true,
      context: {
        currentUser: { entityId: 'a', name: 'Ada', username: null },
        quickStats: { totalEntities: 4, totalPreferences: 0, totalDislikes: 0, familySize: 0 },
      },
    });

    const { result } = renderHook(() => useGraphOverview(null, { maxDepth: 1 }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.userEntityId).toBe('a');
    expect(result.current.subgraph?.nodes.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('still reports a context request the server refused outright', async () => {
    serve({ success: false, context: null });

    const { result } = renderHook(() => useGraphOverview(null));

    await waitFor(() => expect(result.current.error).toBe('Unable to resolve user context'));

    expect(result.current.subgraph).toBeNull();
  });
});
