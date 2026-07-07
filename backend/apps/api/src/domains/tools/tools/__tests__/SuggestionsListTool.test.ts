/* eslint-disable @typescript-eslint/no-explicit-any */
import { SuggestionsListTool } from '../SuggestionsListTool';

const ctx = { userId: 'user-1' };

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

function action(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Suggestion ${id}`,
    text: 'Do the thing',
    imageUrl: null,
    priority: 1,
    metadata: {},
    seen: false,
    dismissed: false,
    threadId: null,
    createdAt: new Date('2026-07-06T12:00:00Z'),
    updatedAt: new Date('2026-07-06T12:00:00Z'),
    ...overrides,
  } as any;
}

function makeTool(actions: any[] | Error) {
  const findForFeed = jest.fn().mockImplementation(async () => {
    if (actions instanceof Error) {
      throw actions;
    }

    return actions;
  });
  const tool = new SuggestionsListTool({ findForFeed } as any, makeLogger());

  return { tool, findForFeed };
}

describe('SuggestionsListTool', () => {
  it('declares the curated read-only suggestions intent', () => {
    const { tool } = makeTool([]);

    expect(tool.schema.name).toBe('suggestions.list');
    expect(tool.schema.domain).toBe('suggestions');
    expect(tool.schema.privacy).toEqual({
      access: 'read',
      sensitivity: 'personal',
      destructive: false,
      external: false,
    });
  });

  it('lists feed suggestions with state and basis provenance (happy path)', async () => {
    const { tool, findForFeed } = makeTool([
      action('a1'),
      action('a2', { seen: true, source: 'hbpe-divergence' }),
      action('a3', { metadata: { source: 'daily-summary' } }),
    ]);

    const result = await tool.execute(ctx, { limit: 10 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      count: 3,
      items: [
        {
          id: 'a1',
          title: 'Suggestion a1',
          text: 'Do the thing',
          priority: 1,
          seen: false,
          dismissed: false,
          createdAt: '2026-07-06T12:00:00.000Z',
          // No source column yet (lands with feat/actions-provenance) — honest default.
          basis: 'unspecified',
        },
        expect.objectContaining({ id: 'a2', seen: true, basis: 'hbpe-divergence' }),
        expect.objectContaining({ id: 'a3', basis: 'daily-summary' }),
      ],
    });
    expect(findForFeed).toHaveBeenCalledWith({ userId: 'user-1' }, 10);
  });

  it('returns a clean empty result when there are no suggestions', async () => {
    const { tool } = makeTool([]);

    const result = await tool.execute(ctx, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ items: [], count: 0 });
  });

  it('surfaces a service failure as a structured tool error', async () => {
    const { tool } = makeTool(new Error('db down'));

    const result = await tool.execute(ctx, {});

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('db down');
  });

  it('rejects malformed input without calling the service', async () => {
    const { tool, findForFeed } = makeTool([]);

    const result = await tool.execute(ctx, { limit: 'lots' });

    expect(result.success).toBe(false);
    expect(findForFeed).not.toHaveBeenCalled();
  });
});
