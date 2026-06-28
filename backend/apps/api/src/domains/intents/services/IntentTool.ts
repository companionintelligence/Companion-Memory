/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LoggerService } from '@ci/common/logging';
import { BaseTool } from '@ci/domains/tools';
import type { ToolExecutionContext, ToolRegistry, ToolSchema } from '@ci/domains/tools';

import { type IntentDefinition, intentToolName } from '../types';

/**
 * Executable adapter for one {@link IntentDefinition}. Registered into the shared
 * {@link ToolRegistry} so curated intents flow to the LLM tool list AND the MCP
 * server exactly like native tools — but with a stable dotted identity, a privacy
 * label, and entity contracts. Execution delegates to the bound underlying tool,
 * merging the binding's `fixedArgs` with the (optionally renamed) caller args.
 */
export class IntentTool extends BaseTool<Record<string, unknown>, unknown> {
  readonly schema: ToolSchema;

  constructor(
    private readonly intent: IntentDefinition,
    private readonly toolRegistry: ToolRegistry,
    protected readonly logger: LoggerService,
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

    const result = await this.toolRegistry.executeTool(tool, context, finalArgs);

    if (!result.success) {
      throw new Error(
        result.error?.message ?? `Intent ${this.intent.name} failed in underlying tool ${tool}`,
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

  protected sanitizeInputForLogging(input: unknown): any {
    return input;
  }
}
