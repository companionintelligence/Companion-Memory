import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphNode } from '@/api/useGraphOverview';

import { useGraphNodeEntity } from './useGraphNodeEntity';

/**
 * A graph node used to reach the detail drawer as a synthetic stub carrying its name and type —
 * and in the dots overview even the description and properties ship empty, so the drawer showed
 * a title and the word "Type". These pin the two hops that replace it (which record the node
 * stands for, then that record), and the fallbacks that keep "Details" from ever dead-ending.
 */

const fetchJson = vi.fn();
const query = vi.fn();

vi.mock('@ci/common', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();

  return { ...original, fetchJson: (...args: unknown[]) => fetchJson(...args) };
});

vi.mock('@apollo/client/react', () => ({
  useApolloClient: () => ({ query }),
}));

const node: GraphNode = {
  id: 'entity-1',
  entity_id: 'entity-1',
  entity_type: 'File',
  name: 'holiday.jpg',
  description: null,
  properties: {},
};

beforeEach(() => {
  fetchJson.mockReset();
  query.mockReset();
});

describe('useGraphNodeEntity', () => {
  it('resolves the node to its real typed entity', async () => {
    fetchJson.mockResolvedValue({ success: true, source: { type: 'file', id: 'file-9' } });
    query.mockResolvedValue({ data: { node: { __typename: 'FileType', id: 'gid-file-9' } } });

    const { result } = renderHook(() => useGraphNodeEntity('token'));
    const entity = await act(() => result.current.resolveNodeEntity(node));

    // The source lookup rides on the graph id; the entity fetch on the record's GlobalUID —
    // base64 of "file:file-9", NOT the node's own entity_id.
    expect(String(fetchJson.mock.calls[0][0])).toContain('entityId=entity-1');
    expect(query.mock.calls[0][0].variables).toEqual({ id: btoa('file:file-9') });
    expect(entity).toEqual({ __typename: 'FileType', id: 'gid-file-9' });
  });

  it('falls back to the graph card when the node stands for no record', async () => {
    fetchJson.mockResolvedValue({ success: true, source: null });

    const { result } = renderHook(() => useGraphNodeEntity('token'));
    const entity = await act(() => result.current.resolveNodeEntity(node));

    expect(query).not.toHaveBeenCalled();
    expect(entity).toEqual(expect.objectContaining({ __typename: 'GenericEntity', id: 'entity-1' }));
  });

  it('falls back to the graph card when the lookup fails', async () => {
    fetchJson.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useGraphNodeEntity('token'));
    const entity = await act(() => result.current.resolveNodeEntity(node));

    expect(entity).toEqual(expect.objectContaining({ __typename: 'GenericEntity' }));
  });

  it('falls back when the record resolves to a type the drawer has no body for', async () => {
    fetchJson.mockResolvedValue({ success: true, source: { type: 'task', id: 'task-1' } });
    query.mockResolvedValue({ data: { node: { __typename: 'TaskType', id: 'gid-task-1' } } });

    const { result } = renderHook(() => useGraphNodeEntity('token'));
    const entity = await act(() => result.current.resolveNodeEntity(node));

    expect(entity).toEqual(expect.objectContaining({ __typename: 'GenericEntity' }));
  });
});
