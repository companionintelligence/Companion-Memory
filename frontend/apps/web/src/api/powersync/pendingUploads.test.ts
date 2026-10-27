import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  data: null as Array<{ tbl: string | null; n: number }> | null,
  error: undefined as Error | undefined,
}));

vi.mock('@powersync/react', () => ({
  useQuery: () => ({ data: h.data, isLoading: false, error: h.error }),
}));

import { PENDING_UPLOADS_SQL, usePendingUploadsByTable } from './pendingUploads';

describe('usePendingUploadsByTable', () => {
  it('reads the queue grouped by the table name inside each row', () => {
    expect(PENDING_UPLOADS_SQL).toContain("json_extract(data, '$.type')");
    expect(PENDING_UPLOADS_SQL).toContain('FROM ps_crud GROUP BY tbl');
  });

  it('keys the counts by table and drops a row with no table', () => {
    h.data = [
      { tbl: 'notes', n: 1 },
      { tbl: 'saved_searches', n: 2 },
      { tbl: null, n: 4 },
    ];

    expect(renderHook(() => usePendingUploadsByTable()).result.current).toEqual({
      notes: 1,
      saved_searches: 2,
    });
  });

  it('is empty where there is no database to ask (a browser, a replica still opening)', () => {
    h.data = [];
    h.error = new Error('PowerSync not configured.');

    expect(renderHook(() => usePendingUploadsByTable()).result.current).toEqual({});
  });
});
