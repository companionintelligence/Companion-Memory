import { Injectable } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import type { ToolResult } from '@ci/domains/tools';
import { ToolRegistry } from '@ci/domains/tools';

import type { DeterministicStep, SkillSpec } from '../entities/SkillVersionEntity';

/** Context available to template expressions during execution. */
interface StepContext {
  input: Record<string, unknown>;
  steps: Record<string, { output: unknown }>;
}

/** Result for a single step in the trace. */
export interface StepTrace {
  id: string;
  tool: string;
  resolvedArgs: Record<string, unknown>;
  result: ToolResult;
  latencyMs: number;
}

/** Full execution result from the DeterministicExecutor. */
export interface DeterministicResult {
  /** Output of the last step that succeeded. */
  output: unknown;
  /** Per-step execution details for audit / debugging. */
  trace: StepTrace[];
  /** Whether all steps completed without error. */
  ok: boolean;
  /** Error message if a step failed. */
  error?: string;
}

/**
 * Plan 02 §4 — executor for skills with `kind = 'deterministic'`.
 *
 * Execution model:
 *  1. Parse the `steps` array from the skill spec.
 *  2. Run each step sequentially; a step failure aborts the run.
 *  3. Between steps, outputs are available as `${steps.<id>.output.<field>}`.
 *  4. The input payload is available as `${input.<field>}`.
 *
 * Template resolution is recursive — nested objects and arrays are walked.
 * Template variables that resolve to `undefined` are left as the literal
 * string (safe degradation, not a hard failure).
 *
 * Tool allowlist is enforced: if a step references a tool not in
 * `spec.tools_allowed`, the step is rejected before execution.
 */
@Injectable()
export class DeterministicExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DeterministicExecutor.name);
  }

  async execute(
    spec: SkillSpec,
    input: Record<string, unknown>,
    context: RequestContext,
  ): Promise<DeterministicResult> {
    const steps = spec.steps ?? [];

    if (steps.length === 0) {
      return { output: null, trace: [], ok: true };
    }

    const allowed = new Set(spec.tools_allowed ?? []);
    const stepCtx: StepContext = { input, steps: {} };
    const trace: StepTrace[] = [];
    let lastOutput: unknown = null;

    for (const step of steps) {
      if (allowed.size > 0 && !allowed.has(step.tool)) {
        const error = `Step '${step.id}': tool '${step.tool}' is not in tools_allowed`;
        this.logger.warn(error, { skillStep: step.id, tool: step.tool });

        return { output: lastOutput, trace, ok: false, error };
      }

      const resolvedArgs = this.resolveArgs(step.args, stepCtx) as Record<string, unknown>;
      const startedAt = Date.now();
      let result: ToolResult;

      try {
        result = await this.toolRegistry.executeTool(step.tool, context, resolvedArgs);
      } catch (err) {
        const error = `Step '${step.id}': tool threw — ${err instanceof Error ? err.message : String(err)}`;
        this.logger.error(error, { skillStep: step.id, tool: step.tool });

        return { output: lastOutput, trace, ok: false, error };
      }

      const stepTrace: StepTrace = {
        id: step.id,
        tool: step.tool,
        resolvedArgs,
        result,
        latencyMs: Date.now() - startedAt,
      };

      trace.push(stepTrace);

      if (!result.success) {
        const error = `Step '${step.id}': tool returned error — ${result.error?.message ?? 'unknown'}`;
        this.logger.warn(error, { skillStep: step.id, tool: step.tool });

        return { output: lastOutput, trace, ok: false, error };
      }

      lastOutput = result.data;
      stepCtx.steps[step.id] = { output: result.data };

      this.logger.debug(`Step '${step.id}' completed`, {
        tool: step.tool,
        latencyMs: stepTrace.latencyMs,
      });
    }

    return { output: lastOutput, trace, ok: true };
  }

  // ─── Template resolution ───────────────────────────────────────────────────

  /**
   * Recursively resolve template expressions in `value`.
   * String values matching `${path.to.field}` are replaced with the
   * corresponding value from `ctx`.
   */
  private resolveArgs(value: unknown, ctx: StepContext): unknown {
    if (typeof value === 'string') {
      return this.resolveTemplate(value, ctx);
    }

    if (Array.isArray(value)) {
      return value.map((v) => this.resolveArgs(v, ctx));
    }

    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.resolveArgs(v, ctx)]),
      );
    }

    return value;
  }

  /**
   * Resolve a single `${path}` template expression.
   * Returns the original string if the template is malformed or the path
   * resolves to `undefined`.
   */
  private resolveTemplate(template: string, ctx: StepContext): unknown {
    const match = /^\$\{([^}]+)\}$/.exec(template);

    if (!match) {
      return template;
    }

    const path = match[1].trim();

    return this.resolvePath(path, ctx as unknown as Record<string, unknown>) ?? template;
  }

  private resolvePath(path: string, obj: Record<string, unknown>): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }

      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }
}

// Re-export the step type for convenience
export type { DeterministicStep };
