import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { SkillInvocationEntity } from '../entities/SkillInvocationEntity';
import { SkillVersionEntity } from '../entities/SkillVersionEntity';

import { DeterministicExecutor } from './DeterministicExecutor';

export interface SkillInvocationResult {
  invocationId: string;
  output: unknown;
  ok: boolean;
  error?: string;
  latencyMs: number;
}

/**
 * Plan 02 §4 — top-level skill executor.
 *
 * Looks up a skill version by ID, dispatches to the correct executor
 * based on `spec.kind`, and persists an invocation record in
 * `ci.skill_invocations` regardless of outcome.
 *
 * Currently supported kinds:
 *   - `deterministic` — handled by DeterministicExecutor
 *   - `llm` / `composite` — not yet implemented; invocations immediately
 *     fail with a descriptive error so callers can detect unsupported kinds.
 */
@Injectable()
export class SkillExecutorService {
  constructor(
    @InjectRepository(SkillVersionEntity)
    private readonly versionRepo: Repository<SkillVersionEntity>,
    @InjectRepository(SkillInvocationEntity)
    private readonly invocationRepo: Repository<SkillInvocationEntity>,
    private readonly deterministicExecutor: DeterministicExecutor,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SkillExecutorService.name);
  }

  /**
   * Execute a skill version and return the result.
   *
   * @param skillVersionId - UUID of the `ci.skill_versions` row to run.
   * @param actorId        - Actor (user or agent) invoking the skill.
   * @param input          - Caller-supplied input, validated against `spec.input` if present.
   * @param context        - Request context forwarded to tool calls.
   */
  async invoke(
    skillVersionId: string,
    actorId: string,
    input: Record<string, unknown>,
    context: RequestContext,
  ): Promise<SkillInvocationResult> {
    const version = await this.versionRepo.findOne({ where: { id: skillVersionId } });

    if (!version) {
      throw new NotFoundException(`Skill version '${skillVersionId}' not found`);
    }

    const invocationId = uuidv7();
    const startedAt = Date.now();

    this.logger.log('Skill invocation started', {
      invocationId,
      skillVersionId,
      kind: version.spec.kind,
      actorId,
    });

    let output: unknown = null;
    let ok = false;
    let error: string | undefined;
    let toolTrace: Record<string, unknown> | null = null;

    try {
      switch (version.spec.kind) {
        case 'deterministic': {
          const result = await this.deterministicExecutor.execute(version.spec, input, context);
          output = result.output;
          ok = result.ok;
          error = result.error;
          toolTrace = { steps: result.trace };
          break;
        }

        case 'llm':
        case 'composite':
          // These executor paths are not yet implemented.
          ok = false;
          error = `Executor for skill kind '${version.spec.kind}' is not yet available`;
          break;

        default: {
          const kind = (version.spec as { kind: string }).kind;
          ok = false;
          error = `Unknown skill kind '${kind}'`;
        }
      }
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
      this.logger.error('Skill invocation threw', {
        invocationId,
        skillVersionId,
        error,
      });
    }

    const latencyMs = Date.now() - startedAt;

    // Persist invocation record (best-effort — never blocks result).
    try {
      await this.invocationRepo.save(
        this.invocationRepo.create({
          id: invocationId,
          skill_version_id: skillVersionId,
          actor_id: actorId,
          input,
          output:
            output !== null && typeof output === 'object'
              ? (output as Record<string, unknown>)
              : { value: output },
          tool_trace: toolTrace,
          latency_ms: latencyMs,
          status: ok ? 'ok' : 'error',
          error: error ?? null,
        }),
      );
    } catch (persistErr) {
      this.logger.warn('Failed to persist skill invocation record', {
        invocationId,
        error: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
    }

    this.logger.log('Skill invocation completed', {
      invocationId,
      ok,
      latencyMs,
    });

    return { invocationId, output, ok, error, latencyMs };
  }
}
