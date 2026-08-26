import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { ToolInvocationEntity } from '../entities/ToolInvocationEntity';
import {
  TOOL_INVOCATION_ERROR_MAX_LENGTH,
  type ToolInvocationOutcome,
  type ToolInvokedPayload,
} from '../events';

/**
 * How long invocation rows are kept. The house convention for telemetry-ish tables (see
 * `RetrievalHealthService.RETENTION_DAYS` and `ImportRetentionCron`), and the bound whose absence
 * is what actually got `ci.api_logs` dropped: a per-tool-call table on a chatty appliance grows
 * without limit, and nothing else would ever delete a row.
 *
 * A year covers every "what changed this quarter / this season" question the ledger exists to
 * answer, and is short enough that the table is never the longest-lived copy of anything.
 */
export const TOOL_INVOCATION_RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most rows one read returns, whatever the caller asks for. */
export const MAX_INVOCATION_PAGE = 200;

/** Default page size when the caller does not say. */
export const DEFAULT_INVOCATION_PAGE = 50;

export interface ToolInvocationQuery {
  /** Restrict to one executable tool name, e.g. `memory_recall`. */
  tool?: string;
  outcome?: ToolInvocationOutcome;
  /** Only rows at or after this instant. */
  since?: Date;
  limit?: number;
}

/**
 * The read/write half of `ci.tool_invocations`.
 *
 * Deliberately narrow: one append, two reads, one prune. There is no update path and no delete
 * path other than retention — a triage ledger someone can edit is not a triage ledger.
 */
@Injectable()
export class ToolInvocationLedgerService {
  constructor(
    @InjectRepository(ToolInvocationEntity)
    private readonly repository: Repository<ToolInvocationEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ToolInvocationLedgerService.name);
  }

  /**
   * Append one invocation.
   *
   * Truncates `error` rather than rejecting an over-long one: the row is worth more than the tail
   * of a stack trace, and the column additionally CHECKs the same bound so a future writer that
   * forgets this fails loudly instead of storing an essay.
   */
  async record(payload: ToolInvokedPayload): Promise<ToolInvocationEntity> {
    const row = this.repository.create({
      id: uuidv7(),
      userId: payload.userId ?? null,
      occurredAt: new Date(payload.occurredAt),
      intent: payload.intent,
      tool: payload.tool,
      domain: payload.domain ?? null,
      source: payload.source,
      correlationId: payload.correlationId ?? null,
      apiKeyId: payload.apiKeyId ?? null,
      capability: payload.capability ?? null,
      access: payload.access ?? null,
      external: payload.external,
      destructive: payload.destructive,
      outcome: payload.outcome,
      errorCode: payload.errorCode ?? null,
      error: truncateError(payload.error),
      durationMs: payload.durationMs ?? null,
    });

    return this.repository.save(row);
  }

  /** One account's invocations, newest first. */
  async listForUser(userId: string, query: ToolInvocationQuery = {}): Promise<ToolInvocationEntity[]> {
    return this.find({ userId }, query);
  }

  /**
   * Invocations with no account at all — the appliance calling its own tools (background jobs,
   * crons). They belong to nobody, so {@link listForUser} can never return them, which is why the
   * controller exposes them behind their own admin-gated route rather than silently folding them
   * into somebody's page.
   */
  async listSystem(query: ToolInvocationQuery = {}): Promise<ToolInvocationEntity[]> {
    return this.find({ userId: IsNull() }, query);
  }

  private async find(
    scope: Record<string, unknown>,
    query: ToolInvocationQuery,
  ): Promise<ToolInvocationEntity[]> {
    const where: Record<string, unknown> = { ...scope };

    if (query.tool) {
      where.tool = query.tool;
    }

    if (query.outcome) {
      where.outcome = query.outcome;
    }

    if (query.since) {
      where.occurredAt = MoreThanOrEqual(query.since);
    }

    return this.repository.find({
      where,
      order: { occurredAt: 'DESC' },
      take: clampLimit(query.limit),
    });
  }

  /** Drop invocations past {@link TOOL_INVOCATION_RETENTION_DAYS}. Returns the number deleted. */
  async prune(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - TOOL_INVOCATION_RETENTION_DAYS * DAY_MS);
    const result = await this.repository.delete({ occurredAt: LessThan(cutoff) });

    return result.affected ?? 0;
  }
}

/**
 * Clamp to {@link MAX_INVOCATION_PAGE}. An unbounded `take` on a per-tool-call table is a way to
 * ask the appliance to materialise a year of rows into one JSON response.
 */
export function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_INVOCATION_PAGE;
  }

  return Math.min(Math.floor(limit), MAX_INVOCATION_PAGE);
}

/** Truncate to the ledger's cap. `undefined` in, `null` out — the column is nullable. */
export function truncateError(error: string | undefined): string | null {
  if (error == null || error === '') {
    return null;
  }

  return error.length <= TOOL_INVOCATION_ERROR_MAX_LENGTH
    ? error
    : error.slice(0, TOOL_INVOCATION_ERROR_MAX_LENGTH);
}
