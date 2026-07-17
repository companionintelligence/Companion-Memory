/* eslint-disable @typescript-eslint/no-explicit-any */

import { v4 as uuidv4 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

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
   * Convert errors to standardized ToolError format
   */
  protected handleError(error: unknown): ToolError {
    if (error instanceof Error) {
      return {
        code: 'EXECUTION_ERROR',
        message: error.message,
        retryable: true,
        details: {
          name: error.name,
          stack: error.stack,
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
