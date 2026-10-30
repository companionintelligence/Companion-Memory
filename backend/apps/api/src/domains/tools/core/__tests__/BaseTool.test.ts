import { QueryFailedError } from 'typeorm';

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { BaseTool } from '../BaseTool';
import { DATABASE_ERROR_MESSAGE } from '../toolErrorMessage';
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

/** Rethrows with `{ cause }`, the way `ForgetKnowledgeTool` wraps a failed delete. */
class RethrowingTool extends ThrowingTool {
  protected async executeInternal(): Promise<unknown> {
    try {
      runFailingQuery();
    } catch (cause) {
      throw new Error('The delete failed: deadlock detected', { cause });
    }
  }
}

/** A write the database refuses, as TypeORM reports it. */
class RefusedWriteTool extends ThrowingTool {
  protected async executeInternal(): Promise<unknown> {
    throw new QueryFailedError(
      'UPDATE ci.events SET end_time = $1',
      [],
      Object.assign(new Error('new row for relation "events" violates check constraint "valid_time_range"'), {
        code: '23514',
      }),
    );
  }
}

function runFailingQuery(): never {
  throw new Error('deadlock detected');
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

  it('logs the stack of the error a tool wrapped, after its own', async () => {
    const log = logger();

    const result = await new RethrowingTool(log as unknown as LoggerService).execute(
      { userId: 'user-1' } as RequestContext,
      {},
    );

    expect(result.error?.details).toEqual({ name: 'Error' });
    expect(log.error).toHaveBeenCalledWith(
      'Tool execution failed',
      expect.objectContaining({
        stack: expect.stringMatching(
          /RethrowingTool\.executeInternal[\s\S]*caused by: Error: deadlock detected\n\s+at runFailingQuery/,
        ),
      }),
    );
  });

  it("keeps a database error's own text for the log and tells the caller only that the database refused", async () => {
    const log = logger();

    const result = await new RefusedWriteTool(log as unknown as LoggerService).execute(
      { userId: 'user-1' } as RequestContext,
      {},
    );

    expect(result.error?.message).toBe(DATABASE_ERROR_MESSAGE);
    expect(JSON.stringify(result)).not.toMatch(/valid_time_range|relation/);
    expect(log.error).toHaveBeenCalledWith(
      'Tool execution failed',
      expect.objectContaining({ originalError: expect.stringContaining('valid_time_range') }),
    );
  });
});
