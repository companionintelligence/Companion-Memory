import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { ToolInvocationEntity, type ToolInvocationStatus } from '../entities/ToolInvocationEntity';

export interface ToolInvocationRecord {
  actorId?: string;
  toolName: string;
  provider?: string;
  args?: unknown;
  result?: unknown;
  status: ToolInvocationStatus;
  latencyMs?: number;
  skillInvocationId?: string;
  errorCode?: string;
  errorMessage?: string;
}

const MAX_JSON_BYTES = 64 * 1024;

/**
 * Plan 06 §3.4 — write one row per tool invocation (success, error, denial)
 * for audit, drift tracking, and future eval scoreboards. Truncates oversized
 * args/results so a runaway tool can't bloat the DB; the original size is
 * preserved as a `_truncated_to` marker.
 */
@Injectable()
export class ToolInvocationLogger {
  constructor(
    @InjectRepository(ToolInvocationEntity)
    private readonly repo: Repository<ToolInvocationEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext('ToolInvocationLogger');
  }

  async record(record: ToolInvocationRecord): Promise<void> {
    try {
      const entity = this.repo.create({
        id: uuidv7(),
        actor_id: record.actorId ?? null,
        tool_name: record.toolName,
        provider: record.provider ?? null,
        args: this.truncate(record.args),
        result: this.truncate(record.result),
        status: record.status,
        latency_ms: record.latencyMs ?? null,
        skill_invocation_id: record.skillInvocationId ?? null,
        error_code: record.errorCode ?? null,
        error_message: record.errorMessage ?? null,
        required_confirmation: false,
        confirmed_by: null,
      });

      await this.repo.save(entity);
    } catch (error) {
      // Never let audit logging break a tool execution. Surface at warn level
      // so OTel (plan 14) can pick it up later.
      this.logger.warn('Failed to persist tool invocation', {
        tool: record.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Replace oversized JSONB blobs with a small marker so we still know they
   * happened without bloating the table. JSONB columns accept any
   * JSON-serializable value, so we always wrap non-object scalars under a
   * single key for storage consistency.
   */
  private truncate(value: unknown): Record<string, unknown> | null {
    if (value == null) {
      return null;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return { _unserializable: true };
    }

    if (serialized.length > MAX_JSON_BYTES) {
      return { _truncated_from_bytes: serialized.length, _preview: serialized.slice(0, 512) };
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return { value: value as unknown };
  }
}
