import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { ToolResult, ToolRegistry } from '@ci/domains/tools';

import type { SkillSpec } from '../../entities/SkillVersionEntity';
import { DeterministicExecutor } from '../DeterministicExecutor';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLogger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  } as unknown as LoggerService;
}

function makeRegistry(results: Record<string, ToolResult>): Pick<ToolRegistry, 'executeTool'> {
  return {
    executeTool: jest.fn(async (name: string) => {
      const r = results[name];
      if (!r) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `Tool '${name}' not found`, retryable: false },
        };
      }

      return r;
    }),
  };
}

const CTX: RequestContext = { userId: 'u1', traceId: 'r1' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DeterministicExecutor', () => {
  it('returns ok=true and last output for a successful single-step skill', async () => {
    const registry = makeRegistry({ myTool: { success: true, data: { answer: 42 } } });
    const executor = new DeterministicExecutor(registry as unknown as ToolRegistry, makeLogger());

    const spec: SkillSpec = {
      kind: 'deterministic',
      tools_allowed: ['myTool'],
      steps: [{ id: 'step1', tool: 'myTool', args: { q: 'hello' } }],
    };

    const result = await executor.execute(spec, {}, CTX);

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ answer: 42 });
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0].id).toBe('step1');
  });

  it('passes output from one step to the next via ${steps.id.output.X}', async () => {
    const registry = makeRegistry({
      step1Tool: { success: true, data: { value: 'hello' } },
      step2Tool: { success: true, data: { echoed: 'hello world' } },
    });
    const executeTool = registry.executeTool as jest.Mock;
    const executor = new DeterministicExecutor(registry as unknown as ToolRegistry, makeLogger());

    const spec: SkillSpec = {
      kind: 'deterministic',
      tools_allowed: ['step1Tool', 'step2Tool'],
      steps: [
        { id: 'first', tool: 'step1Tool', args: {} },
        { id: 'second', tool: 'step2Tool', args: { text: '${steps.first.output.value}' } },
      ],
    };

    const result = await executor.execute(spec, {}, CTX);

    expect(result.ok).toBe(true);
    // Verify step2 received the resolved arg
    const step2Call = executeTool.mock.calls[1];
    expect(step2Call[2]).toEqual({ text: 'hello' });
  });

  it('resolves ${input.X} from the invocation input', async () => {
    const registry = makeRegistry({ echoTool: { success: true, data: { ok: true } } });
    const executeTool = registry.executeTool as jest.Mock;
    const executor = new DeterministicExecutor(registry as unknown as ToolRegistry, makeLogger());

    const spec: SkillSpec = {
      kind: 'deterministic',
      tools_allowed: ['echoTool'],
      steps: [{ id: 's', tool: 'echoTool', args: { name: '${input.userName}' } }],
    };

    await executor.execute(spec, { userName: 'Alice' }, CTX);

    expect(executeTool.mock.calls[0][2]).toEqual({ name: 'Alice' });
  });

  it('returns ok=false and stops at the failing step', async () => {
    const registry = makeRegistry({
      okTool: { success: true, data: 'good' },
      badTool: { success: false, error: { code: 'ERR', message: 'boom', retryable: false } },
    });
    const executor = new DeterministicExecutor(registry as unknown as ToolRegistry, makeLogger());

    const spec: SkillSpec = {
      kind: 'deterministic',
      tools_allowed: ['okTool', 'badTool', 'okTool'],
      steps: [
        { id: 's1', tool: 'okTool', args: {} },
        { id: 's2', tool: 'badTool', args: {} },
        { id: 's3', tool: 'okTool', args: {} },
      ],
    };

    const result = await executor.execute(spec, {}, CTX);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
    // Third step must not have run
    expect(result.trace).toHaveLength(2);
  });

  it('rejects tools not in tools_allowed', async () => {
    const registry = makeRegistry({ secret: { success: true, data: 'leaked' } });
    const executeTool = registry.executeTool as jest.Mock;
    const executor = new DeterministicExecutor(registry as unknown as ToolRegistry, makeLogger());

    const spec: SkillSpec = {
      kind: 'deterministic',
      tools_allowed: ['allowedTool'],
      steps: [{ id: 's', tool: 'secret', args: {} }],
    };

    const result = await executor.execute(spec, {}, CTX);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not in tools_allowed');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('allows any tool when tools_allowed is empty', async () => {
    const registry = makeRegistry({ anyTool: { success: true, data: 1 } });
    const executor = new DeterministicExecutor(registry as unknown as ToolRegistry, makeLogger());

    const spec: SkillSpec = {
      kind: 'deterministic',
      // no tools_allowed ⟹ open
      steps: [{ id: 's', tool: 'anyTool', args: {} }],
    };

    const result = await executor.execute(spec, {}, CTX);

    expect(result.ok).toBe(true);
  });

  it('returns ok=true with no steps', async () => {
    const registry = makeRegistry({});
    const executor = new DeterministicExecutor(registry as unknown as ToolRegistry, makeLogger());

    const spec: SkillSpec = { kind: 'deterministic', steps: [] };
    const result = await executor.execute(spec, {}, CTX);

    expect(result.ok).toBe(true);
    expect(result.trace).toHaveLength(0);
    expect(result.output).toBeNull();
  });
});
