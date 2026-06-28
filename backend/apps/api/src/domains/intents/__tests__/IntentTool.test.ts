/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';
import type { ToolRegistry } from '@ci/domains/tools';

import { IntentRegistry } from '../services/IntentRegistry';
import { IntentTool } from '../services/IntentTool';
import type { IntentDefinition } from '../types';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function intent(name: string): IntentDefinition {
  const def = new IntentRegistry().getIntent(name);
  if (!def) {
    throw new Error(`fixture intent missing: ${name}`);
  }

  return def;
}

const context: RequestContext = { userId: 'user-1' };

describe('IntentTool', () => {
  it('exposes the underscored tool name and a domain-scoped category', () => {
    const registry = { executeTool: jest.fn() } as unknown as ToolRegistry;
    const tool = new IntentTool(intent('memory.recall'), registry, makeLogger());

    expect(tool.schema.name).toBe('memory_recall');
    expect(tool.schema.category).toBe('intent:memory');
  });

  it('merges fixedArgs with caller args and delegates to the bound native tool', async () => {
    const executeTool = jest.fn().mockResolvedValue({ success: true, data: { hits: [] } });
    const registry = { executeTool } as unknown as ToolRegistry;
    const tool = new IntentTool(intent('people.find'), registry, makeLogger());

    const result = await tool.execute(context, { query: 'Sarah', maxResults: 5 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ hits: [] });
    expect(executeTool).toHaveBeenCalledTimes(1);

    const [toolName, , args] = executeTool.mock.calls[0];
    expect(toolName).toBe('databaseSearch');
    // fixedArgs (entity scope) + caller args, caller-overridable.
    expect(args).toEqual({ entityTypes: ['person'], query: 'Sarah', maxResults: 5 });
  });

  it('surfaces the underlying tool failure as a failed ToolResult', async () => {
    const executeTool = jest
      .fn()
      .mockResolvedValue({ success: false, error: { code: 'BOOM', message: 'nope', retryable: false } });
    const registry = { executeTool } as unknown as ToolRegistry;
    const tool = new IntentTool(intent('knowledge.search'), registry, makeLogger());

    const result = await tool.execute(context, { query: 'x' });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('nope');
  });
});
