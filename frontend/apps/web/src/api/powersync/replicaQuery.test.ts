import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = { onResult: (result: { rows?: { _array: unknown[] } }) => void; onError?: (error: Error) => void };

const h = vi.hoisted(() => ({
  database: null as null | { watch: ReturnType<typeof vi.fn> },
  watches: [] as Array<{ sql: string; parameters: unknown[]; handler: Handler; signal: AbortSignal }>,
}));

vi.mock('./deviceFallback', () => ({
  useReplicaDatabase: () => h.database,
}));

import { useReplicaQuery } from './replicaQuery';

function fakeDatabase() {
  return {
    watch: vi.fn((sql: string, parameters: unknown[], handler: Handler, options: { signal: AbortSignal }) => {
      h.watches.push({ sql, parameters, handler, signal: options.signal });
    }),
  };
}

const SQL = 'SELECT id FROM notes WHERE id = ?';

describe('useReplicaQuery', () => {
  beforeEach(() => {
    h.database = null;
    h.watches = [];
  });

  it('answers with nothing, not loading and no error, where no replica is bound', () => {
    const { result } = renderHook(() => useReplicaQuery<{ id: string }>(SQL, ['a']));

    expect(result.current).toMatchObject({ data: [], isLoading: false, error: undefined });
    expect(h.watches).toHaveLength(0);
  });

  it('watches the query on the bound replica and shows each answer', () => {
    h.database = fakeDatabase();

    const { result } = renderHook(() => useReplicaQuery<{ id: string }>(SQL, ['a']));

    expect(result.current.isLoading).toBe(true);
    expect(h.watches).toHaveLength(1);
    expect(h.watches[0]).toMatchObject({ sql: SQL, parameters: ['a'] });

    act(() => h.watches[0].handler.onResult({ rows: { _array: [{ id: 'a' }] } }));
    expect(result.current).toMatchObject({ data: [{ id: 'a' }], isLoading: false, error: undefined });

    act(() => h.watches[0].handler.onResult({ rows: { _array: [] } }));
    expect(result.current.data).toEqual([]);
  });

  it('keeps the same hook order when the replica opens under a mounted component', () => {
    const { result, rerender } = renderHook(() => useReplicaQuery<{ id: string }>(SQL, ['a']));

    expect(result.current.isLoading).toBe(false);

    h.database = fakeDatabase();
    expect(() => rerender()).not.toThrow();

    expect(result.current.isLoading).toBe(true);
    expect(h.watches).toHaveLength(1);

    act(() => h.watches[0].handler.onResult({ rows: { _array: [{ id: 'a' }] } }));
    expect(result.current.data).toEqual([{ id: 'a' }]);

    // Torn down again (sign-out, a failed reopen): nothing is shown and nothing is asked.
    h.database = null;
    rerender();
    expect(result.current).toMatchObject({ data: [], isLoading: false });
    expect(h.watches[0].signal.aborted).toBe(true);
  });

  it('aborts the watch on unmount and ignores an answer that arrives after', () => {
    h.database = fakeDatabase();

    const { result, unmount } = renderHook(() => useReplicaQuery<{ id: string }>(SQL, ['a']));

    unmount();
    expect(h.watches[0].signal.aborted).toBe(true);
    expect(() => h.watches[0].handler.onResult({ rows: { _array: [{ id: 'late' }] } })).not.toThrow();
    expect(result.current.data).toEqual([]);
  });

  it('subscribes anew when the statement or its parameters change', () => {
    h.database = fakeDatabase();

    const { result, rerender } = renderHook(({ id }) => useReplicaQuery<{ id: string }>(SQL, [id]), {
      initialProps: { id: 'a' },
    });

    act(() => h.watches[0].handler.onResult({ rows: { _array: [{ id: 'a' }] } }));
    rerender({ id: 'b' });

    expect(h.watches).toHaveLength(2);
    expect(h.watches[0].signal.aborted).toBe(true);
    expect(h.watches[1].parameters).toEqual(['b']);
    // The old answer is not shown as if it were the new query's.
    expect(result.current).toMatchObject({ data: [], isLoading: true });
  });

  it('reports a failed watch, and refresh() subscribes again with the error cleared', () => {
    h.database = fakeDatabase();

    const { result } = renderHook(() => useReplicaQuery<{ id: string }>(SQL, ['a']));

    act(() => h.watches[0].handler.onError?.(new Error('no such table')));
    expect(result.current).toMatchObject({ data: [], isLoading: false });
    expect(result.current.error?.message).toBe('no such table');

    act(() => result.current.refresh());
    expect(h.watches).toHaveLength(2);
    expect(result.current).toMatchObject({ isLoading: true, error: undefined });

    act(() => h.watches[1].handler.onResult({ rows: { _array: [{ id: 'a' }] } }));
    expect(result.current).toMatchObject({ data: [{ id: 'a' }], isLoading: false, error: undefined });
  });
});
