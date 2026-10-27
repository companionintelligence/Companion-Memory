import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { BaseTool } from '../BaseTool';
import type { IntentDefinition } from '../types';

/**
 * A failing tool's `ToolError` goes back to the caller (an MCP client, the REST
 * tools route), so it must not carry the server's stack trace. The stack still
 * reaches the server log.
 */
class ThrowingTool extends BaseTool<unknown, unknown> {
  readonly schema = { name: 'test_throwing' } as IntentDefinition;

  constructor(protected readonly logger: LoggerService) {
    super();
  }

  protected async executeInternal(): Promise<unknown> {
    throw new Error('TMDB_API_KEY environment variable not set');
  }
}

function logger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe('BaseTool error handling', () => {
  it('returns the message and error name without a stack trace', async () => {
    const result = await new ThrowingTool(logger() as unknown as LoggerService).execute(
      { userId: 'user-1' } as RequestContext,
      {},
    );

    expect(result.success).toBe(false);
    expect(result.error).toEqual({
      code: 'EXECUTION_ERROR',
      message: 'TMDB_API_KEY environment variable not set',
      retryable: true,
      details: { name: 'Error' },
    });
    expect(JSON.stringify(result)).not.toMatch(/BaseTool|at async|\.ts:\d+/);
  });

  it('still logs the stack on the server', async () => {
    const log = logger();

    await new ThrowingTool(log as unknown as LoggerService).execute(
      { userId: 'user-1' } as RequestContext,
      {},
    );

    expect(log.error).toHaveBeenCalledWith(
      'Tool execution failed',
      expect.objectContaining({ stack: expect.stringContaining('ThrowingTool.executeInternal') }),
    );
  });
});
