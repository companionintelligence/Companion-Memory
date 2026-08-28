import { useQuery } from '@apollo/client';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { usePlanBadgeCount } from './usePlanBadgeCount';

// Same technique as usePlanTasks.test.ts: mock Apollo's hook directly so the
// GraphQL round-trip can be skipped and the mapping into `openCount` asserted
// against controlled data.
vi.mock('@apollo/client', async (orig) => ({
  ...(await orig<typeof import('@apollo/client')>()),
  useQuery: vi.fn(),
}));

const mockedUseQuery = vi.mocked(useQuery);

function node(id: string, status: string) {
  return { node: { id, status } };
}

describe('usePlanBadgeCount', () => {
  it('is 0 before the query has answered', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as never);

    expect(renderHook(() => usePlanBadgeCount()).result.current).toBe(0);
  });

  // Counts only the same statuses openCount does (open/in_progress/proposed,
  // plus anything with a pending automation change) — reusing that function
  // rather than a second, drifting definition of "open".
  it('reuses openCount to count what still wants doing', () => {
    mockedUseQuery.mockReturnValue({
      data: {
        tasks: {
          edges: [
            node('t1', 'open'),
            node('t2', 'in_progress'),
            node('t3', 'proposed'),
            node('t4', 'done'),
            node('t5', 'archived'),
          ],
        },
        taskPendingChanges: [{ taskId: 't4' }],
      },
    } as never);

    // t1/t2/t3 by status, t4 by its pending change despite being done — 4.
    expect(renderHook(() => usePlanBadgeCount()).result.current).toBe(4);
  });
});
