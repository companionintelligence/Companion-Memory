import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository, type SelectQueryBuilder } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import type { ToolPrincipal } from '../core/types';
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
  /**
   * Restrict to one principal — `managed-app` is the "what have the installed apps been doing"
   * question, `owner` its complement.
   */
  principal?: ToolPrincipal;
  /** Restrict to one installed app by api-key name, e.g. `app:ci-openclaw:ci-marketplace`. */
  principalName?: string;
  /** Continue a previous page. Encodes the last row's `(occurredAt, id)`; see {@link encodeCursor}. */
  cursor?: ToolInvocationCursor;
}

/**
 * Where a page left off.
 *
 * Both halves, not just the timestamp: `occurred_at` is emitted by the caller and is NOT unique —
 * a chat turn dispatching three tools in the same millisecond is ordinary — so a cursor keyed on
 * it alone either repeats rows or skips them at every page boundary. `id` breaks the tie.
 *
 * `id` cannot carry the ordering by itself either, even though it is a uuidv7: it is minted at
 * INSERT while `occurred_at` is stamped at emit, and the event is durable — a row replayed off a
 * dead letter gets a new, later id for an older occurrence. Ordering by id would file that replay
 * at the top of the page as if it had just happened.
 */
export interface ToolInvocationCursor {
  occurredAt: Date;
  id: string;
}

/** One page of the ledger, plus how to ask for the next. */
export interface ToolInvocationPage {
  items: ToolInvocationEntity[];
  /** `null` when this page is the end of the ledger. */
  nextCursor: string | null;
}

/**
 * Opaque, URL-safe encoding of a {@link ToolInvocationCursor}.
 *
 * Opaque because the client must not compose one: a hand-built cursor is a way to ask for an
 * arbitrary offset into someone's history, and the shape is ours to change.
 */
export function encodeCursor(cursor: ToolInvocationCursor): string {
  return Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or throw. Never silently falls back to the first page: a client that pages with
 * a cursor this service cannot read would otherwise loop over page one forever, reporting the same
 * rows as if they were new ones.
 */
export function decodeCursor(raw: string): ToolInvocationCursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  // The FIRST separator, because the timestamp is the half with the guaranteed
  // format: `Date.toISOString()` can never contain a `|`, while the id is only
  // "whatever the primary key happens to be" and is a uuid by convention rather
  // than by contract. Splitting on the last one would let a separator in an id
  // eat into the timestamp and turn a valid cursor into a 400.
  const separator = decoded.indexOf('|');

  if (separator <= 0) {
    throw new Error('Malformed cursor');
  }

  const occurredAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(occurredAt.getTime()) || id === '') {
    throw new Error('Malformed cursor');
  }

  return { occurredAt, id };
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
      principal: payload.principal ?? null,
      principalName: payload.principalName ?? null,
      tier: payload.tier ?? null,
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
  async listForUser(userId: string, query: ToolInvocationQuery = {}): Promise<ToolInvocationPage> {
    return this.find((qb) => qb.andWhere('invocation.user_id = :userId', { userId }), query);
  }

  /**
   * Invocations with no account at all — the appliance calling its own tools (background jobs,
   * crons). They belong to nobody, so {@link listForUser} can never return them, which is why the
   * controller exposes them behind their own admin-gated route rather than silently folding them
   * into somebody's page.
   */
  async listSystem(query: ToolInvocationQuery = {}): Promise<ToolInvocationPage> {
    return this.find((qb) => qb.andWhere('invocation.user_id IS NULL'), query);
  }

  /**
   * The one read, keyset-paginated on `(occurred_at, id)` descending.
   *
   * A query builder rather than `repository.find`, for the cursor: the predicate is a row
   * comparison — `(occurred_at, id) < (:at, :id)` — which is the whole reason this pages correctly
   * and which `FindOptionsWhere` cannot express. Postgres compares row constructors
   * lexicographically, so that single clause means "strictly older, or the same instant and a
   * lower id" without the three-way OR a hand-expanded version needs.
   *
   * Keyset and not OFFSET because the newest end of this table is where rows are being appended:
   * an offset page-two re-reads rows that page one already showed, every time a tool ran in
   * between. The ledger's whole job is to be trustworthy about what happened, and a paginator
   * that duplicates or drops rows undermines that more quietly than a missing feature would.
   */
  private async find(
    scope: (qb: SelectQueryBuilder<ToolInvocationEntity>) => SelectQueryBuilder<ToolInvocationEntity>,
    query: ToolInvocationQuery,
  ): Promise<ToolInvocationPage> {
    const limit = clampLimit(query.limit);
    const builder = scope(this.repository.createQueryBuilder('invocation'));

    if (query.tool) {
      builder.andWhere('invocation.tool = :tool', { tool: query.tool });
    }

    if (query.outcome) {
      builder.andWhere('invocation.outcome = :outcome', { outcome: query.outcome });
    }

    if (query.since) {
      builder.andWhere('invocation.occurred_at >= :since', { since: query.since });
    }

    if (query.principal) {
      builder.andWhere('invocation.principal = :principal', { principal: query.principal });
    }

    if (query.principalName) {
      builder.andWhere('invocation.principal_name = :principalName', {
        principalName: query.principalName,
      });
    }

    if (query.cursor) {
      builder.andWhere('(invocation.occurred_at, invocation.id) < (:cursorAt, CAST(:cursorId AS uuid))', {
        cursorAt: query.cursor.occurredAt,
        cursorId: query.cursor.id,
      });
    }

    // One more than asked for, so "is there a next page" is answered by the rows themselves
    // rather than by a second COUNT over a year of history.
    const rows = await builder
      .orderBy('invocation.occurred_at', 'DESC')
      .addOrderBy('invocation.id', 'DESC')
      .take(limit + 1)
      .getMany();

    const items = rows.slice(0, limit);
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        rows.length > limit && last != null
          ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
    };
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
