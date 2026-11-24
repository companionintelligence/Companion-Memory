/* eslint-disable @typescript-eslint/no-explicit-any */

import { v4 as uuidv4 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { toolErrorMessage } from './toolErrorMessage';
import type { IntentDefinition, ToolResult, ToolExecutionContext, ToolError } from './types';

/**
 * Base class for all tools with built-in error handling and observability
 */
export abstract class BaseTool<TInput = any, TOutput = any> {
  protected abstract logger: LoggerService;

  /**
   * Tool schema definition - must be implemented by subclasses. Every tool is an intent, so the
   * schema carries the curated intent metadata (domain, privacy, phrases) alongside parameters.
   */
  abstract readonly schema: IntentDefinition;

  /**
   * Core execution logic - must be implemented by subclasses
   */
  protected abstract executeInternal(context: ToolExecutionContext, input: TInput): Promise<TOutput>;

  /**
   * Optional input validation - override if needed
   */
  protected validateInput(input: unknown): TInput {
    // Default: pass through (subclasses can override for strict validation)
    return input as TInput;
  }

  /**
   * Why `input` would fail {@link validateInput}, or `undefined` when it passes. The registry asks
   * this before it queues a call for confirmation (see `ToolHandle.checkInput`), so a call that
   * could only fail is refused at once instead of becoming a card in Approvals.
   */
  checkInput(input: unknown): string | undefined {
    try {
      this.validateInput(input);

      return undefined;
    } catch (error) {
      return describeInvalidInput(error);
    }
  }

  /**
   * Public execution method with error handling and observability
   */
  async execute(context: RequestContext, input: unknown): Promise<ToolResult<TOutput>> {
    const executionId = uuidv4();
    const startTime = new Date();
    const toolContext: ToolExecutionContext = {
      ...context,
      toolName: this.schema.name,
      executionId,
      startTime,
    };

    this.logger.debug(`Starting tool execution`, {
      toolName: this.schema.name,
      executionId,
      userId: context.userId,
      input: this.sanitizeInputForLogging(input),
    });

    try {
      // Validate input
      const validatedInput = this.validateInput(input);

      // Execute the tool
      const result = await this.executeInternal(toolContext, validatedInput);
      const executionTimeMs = Date.now() - startTime.getTime();

      this.logger.debug(`Tool execution completed successfully`, {
        toolName: this.schema.name,
        executionId,
        executionTimeMs,
        userId: context.userId,
      });

      return {
        success: true,
        data: result,
        executionTimeMs,
        metadata: {
          executionId,
          toolName: this.schema.name,
        },
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime.getTime();
      const toolError = this.handleError(error);

      this.logger.error(`Tool execution failed`, {
        toolName: this.schema.name,
        executionId,
        executionTimeMs,
        userId: context.userId,
        error: toolError,
        originalError: error instanceof Error ? error.message : String(error),
        // The stack stays here, in the server's log. It is not in `toolError`,
        // which goes back to the caller.
        stack: error instanceof Error ? stackWithCauses(error) : undefined,
      });

      return {
        success: false,
        error: toolError,
        executionTimeMs,
        metadata: {
          executionId,
          toolName: this.schema.name,
        },
      };
    }
  }

  /**
   * Convert errors to standardized ToolError format.
   *
   * What this returns goes back to whoever called the tool (an MCP client, the
   * REST tools route), so it carries no stack trace: that named the server's
   * own file paths and dependencies for every failing tool. `execute` logs the
   * stack instead. A database error's message is replaced too
   * ({@link toolErrorMessage}); `execute` logs the original.
   */
  protected handleError(error: unknown): ToolError {
    if (error instanceof Error) {
      return {
        code: 'EXECUTION_ERROR',
        message: toolErrorMessage(error),
        retryable: true,
        details: {
          name: error.name,
        },
      };
    }

    return {
      code: 'UNKNOWN_ERROR',
      message: String(error),
      retryable: true,
    };
  }

  /**
   * Sanitize input for logging (remove sensitive data)
   */
  protected sanitizeInputForLogging(input: unknown): any {
    // Basic implementation - subclasses can override for more sophisticated sanitization
    if (typeof input === 'object' && input !== null) {
      const sanitized = { ...input } as any;
      // Remove common sensitive fields
      const sensitiveFields = ['password', 'token', 'secret', 'key'];
      for (const field of sensitiveFields) {
        if (field in sanitized) {
          sanitized[field] = '[REDACTED]';
        }
      }

      return sanitized;
    }

    return input;
  }
}

/**
 * One sentence for an input that failed validation. A zod error's own `message` is its issues as a
 * JSON array; this lists them as `path: message` instead (`entityIds.0: Invalid uuid`), which is
 * what a model reading the error needs to fix its call.
 */
function describeInvalidInput(error: unknown): string {
  const issues = (error as { issues?: unknown } | null)?.issues;

  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((issue: { path?: unknown; message?: unknown }) => {
        const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : 'input';

        return `${path}: ${String(issue.message)}`;
      })
      .join('; ');
  }

  return toolErrorMessage(error);
}

/**
 * `error.stack`, followed by the stack of each error it wraps as its `cause`. A tool that rethrows
 * with `{ cause }` (`ForgetKnowledgeTool`'s `PartialForgetError`) would otherwise log only the
 * frames of its own rethrow, not the ones where the failure happened.
 */
function stackWithCauses(error: Error): string | undefined {
  const seen = new Set<Error>([error]);
  let stack = error.stack;

  for (let cause = error.cause; cause instanceof Error && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    stack = `${stack ?? ''}\ncaused by: ${cause.stack ?? cause.message}`;
  }

  return stack;
}
