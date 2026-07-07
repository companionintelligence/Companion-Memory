/* eslint-disable @typescript-eslint/no-explicit-any */
import { SuggestionsFeedbackTool } from '../SuggestionsFeedbackTool';

const ctx = { userId: 'user-1' };

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

function makeTool({
  seenResult = null,
  dismissedResult = null,
  error,
}: { seenResult?: any; dismissedResult?: any; error?: Error } = {}) {
  const markAsSeen = jest.fn().mockImplementation(async () => {
    if (error) {
      throw error;
    }

    return seenResult;
  });
  const markAsDismissed = jest.fn().mockImplementation(async () => {
    if (error) {
      throw error;
    }

    return dismissedResult;
  });
  const tool = new SuggestionsFeedbackTool({ markAsSeen, markAsDismissed } as any, makeLogger());

  return { tool, markAsSeen, markAsDismissed };
}

describe('SuggestionsFeedbackTool', () => {
  it('declares a write but non-destructive intent (reversible presentation state)', () => {
    const { tool } = makeTool();

    expect(tool.schema.name).toBe('suggestions.feedback');
    expect(tool.schema.domain).toBe('suggestions');
    expect(tool.schema.privacy).toEqual({
      access: 'write',
      sensitivity: 'personal',
      destructive: false,
      external: false,
    });
  });

  it('marks a suggestion as seen (happy path)', async () => {
    const { tool, markAsSeen, markAsDismissed } = makeTool({
      seenResult: { id: 'a1', seen: true, dismissed: false },
    });

    const result = await tool.execute(ctx, { id: 'a1', action: 'seen' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      applied: true,
      id: 'a1',
      action: 'seen',
      suggestion: { id: 'a1', seen: true, dismissed: false },
    });
    expect(markAsSeen).toHaveBeenCalledWith({ userId: 'user-1' }, 'a1');
    expect(markAsDismissed).not.toHaveBeenCalled();
  });

  it('marks a suggestion as dismissed (happy path)', async () => {
    const { tool, markAsDismissed } = makeTool({
      dismissedResult: { id: 'a2', seen: false, dismissed: true },
    });

    const result = await tool.execute(ctx, { id: 'a2', action: 'dismissed' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      applied: true,
      id: 'a2',
      action: 'dismissed',
      suggestion: { id: 'a2', seen: false, dismissed: true },
    });
    expect(markAsDismissed).toHaveBeenCalledWith({ userId: 'user-1' }, 'a2');
  });

  it('reports applied:false when the suggestion does not exist for this user (empty case)', async () => {
    const { tool } = makeTool();

    const result = await tool.execute(ctx, { id: 'ghost', action: 'dismissed' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      applied: false,
      id: 'ghost',
      action: 'dismissed',
      reason: 'suggestion not found',
    });
  });

  it('surfaces a service failure as a structured tool error', async () => {
    const { tool } = makeTool({ error: new Error('db down') });

    const result = await tool.execute(ctx, { id: 'a1', action: 'seen' });

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('db down');
  });

  it('rejects an unknown feedback action without calling the service', async () => {
    const { tool, markAsSeen, markAsDismissed } = makeTool();

    const result = await tool.execute(ctx, { id: 'a1', action: 'archived' });

    expect(result.success).toBe(false);
    expect(markAsSeen).not.toHaveBeenCalled();
    expect(markAsDismissed).not.toHaveBeenCalled();
  });
});
