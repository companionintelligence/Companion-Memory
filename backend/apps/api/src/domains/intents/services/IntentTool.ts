/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LoggerService } from '@ci/common/logging';
import { BaseTool } from '@ci/domains/tools';
import type { ToolError, ToolExecutionContext, ToolRegistry, ToolSchema } from '@ci/domains/tools';

import { type IntentDefinition, intentToolName } from '../types';

import type { IntentDonationService } from './IntentDonationService';

/**
 * Carries the bound tool's original {@link ToolError} across the throw boundary
 * so {@link IntentTool.handleError} can re-surface its `code`/`retryable`
 * instead of letting the base handler flatten everything to EXECUTION_ERROR.
 */
class BoundToolError extends Error {
  constructor(readonly toolError: ToolError) {
    super(toolError.message);
    this.name = 'BoundToolError';
  }
}

/**
 * Executable adapter for one {@link IntentDefinition}. Registered into the shared
 * {@link ToolRegistry} so curated intents flow to the LLM tool list AND the MCP
 * server exactly like native tools — but with a stable dotted identity, a privacy
 * label, and entity contracts. Execution delegates to the bound underlying tool,
 * merging the binding's `fixedArgs` with the (optionally renamed) caller args, and
 * donates the invocation as a behavioral signal.
 */
export class IntentTool extends BaseTool<Record<string, unknown>, unknown> {
  readonly schema: ToolSchema;

  constructor(
    private readonly intent: IntentDefinition,
    private readonly toolRegistry: ToolRegistry,
    protected readonly logger: LoggerService,
    private readonly donation?: IntentDonationService,
  ) {
    super();

    this.schema = {
      name: intentToolName(intent.name),
      description: intent.description,
      parameters: intent.parameters,
      category: `intent:${intent.domain}`,
    };
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const { tool, argMap, fixedArgs } = this.intent.binding;

    const callerArgs = this.mapArgs(input ?? {}, argMap);
    const finalArgs = { ...(fixedArgs ?? {}), ...callerArgs };

    const startedAt = Date.now();
    const result = await this.toolRegistry.executeTool(tool, context, finalArgs);

    // Donate the invocation (success or failure) so prediction can learn from it.
    this.donation?.donate({
      intent: this.intent.name,
      domain: this.intent.domain,
      userId: context.userId,
      success: result.success,
      durationMs: Date.now() - startedAt,
      access: this.intent.privacy.access,
      external: this.intent.privacy.external,
    });

    if (!result.success) {
      // Preserve the bound tool's code/retryable so callers' retry logic still
      // works; only synthesise a ToolError when the tool gave none.
      throw new BoundToolError(
        result.error ?? {
          code: 'EXECUTION_ERROR',
          message: `Intent ${this.intent.name} failed in underlying tool ${tool}`,
          retryable: true,
        },
      );
    }

    return result.data;
  }

  /** Rename caller param keys to the underlying tool's keys (identity by default). */
  private mapArgs(input: Record<string, unknown>, argMap?: Record<string, string>): Record<string, unknown> {
    if (!argMap) {
      return { ...input };
    }

    const mapped: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      mapped[argMap[key] ?? key] = value;
    }

    return mapped;
  }

  protected handleError(error: unknown): ToolError {
    // Re-surface the bound tool's original ToolError (code + retryable);
    // anything else falls back to the base mapping.
    if (error instanceof BoundToolError) {
      return error.toolError;
    }

    return super.handleError(error);
  }

  protected sanitizeInputForLogging(input: unknown): any {
    // Keep the base redaction of common secret fields, then drop the
    // potentially large / PII-heavy knowledge-graph `operations` payload.
    const sanitized = super.sanitizeInputForLogging(input);
    if (sanitized && typeof sanitized === 'object' && 'operations' in sanitized) {
      return { ...sanitized, operations: '[REDACTED]' };
    }

    return sanitized;
  }
}
