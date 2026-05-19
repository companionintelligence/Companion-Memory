import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { LlmInvocationEntity, type LlmInvocationStatus } from '../entities/LlmInvocationEntity';
import type { LlmTask } from '../providers/LlmProvider';

export interface LlmInvocationRecord {
  actorId?: string;
  task: LlmTask;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  /** Cost in micro-USD (1e-6 USD). */
  costUsdMicro?: number;
  redacted?: boolean;
  skillInvocationId?: string;
  toolInvocationId?: string;
  status: LlmInvocationStatus;
  errorKind?: string;
}

/**
 * Plan 04 §3.4 — writes one row per LLM call. Used by:
 *   - per-skill / per-actor cost dashboards
 *   - eval drift tracking (which provider produced which answer)
 *   - debugging "why was this routed externally?"
 *
 * Errors never propagate; a failed log must not break the LLM call.
 */
@Injectable()
export class LlmInvocationLogger {
  constructor(
    @InjectRepository(LlmInvocationEntity)
    private readonly repo: Repository<LlmInvocationEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(LlmInvocationLogger.name);
  }

  async record(record: LlmInvocationRecord): Promise<void> {
    try {
      const entity = this.repo.create({
        id: uuidv7(),
        actor_id: record.actorId ?? null,
        task: record.task,
        provider: record.provider,
        model: record.model,
        input_tokens: record.inputTokens ?? null,
        output_tokens: record.outputTokens ?? null,
        latency_ms: record.latencyMs ?? null,
        cost_usd_micro: record.costUsdMicro != null ? String(record.costUsdMicro) : null,
        redacted: record.redacted ?? false,
        skill_invocation_id: record.skillInvocationId ?? null,
        tool_invocation_id: record.toolInvocationId ?? null,
        status: record.status,
        error_kind: record.errorKind ?? null,
      });

      await this.repo.save(entity);
    } catch (error) {
      this.logger.warn('Failed to persist LLM invocation', {
        task: record.task,
        provider: record.provider,
        model: record.model,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
