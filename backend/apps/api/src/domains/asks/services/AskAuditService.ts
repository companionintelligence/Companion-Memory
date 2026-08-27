import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  EntityManager,
  type FindOptionsWhere,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { type DisclosureSummary, summarizeDisclosures } from '../disclosureSummary';
import { type AskAudit, AskAuditEntity } from '../entities/AskAuditEntity';
import type { AskAuditOutcome, RecordAskAuditDto } from '../types';

/**
 * The most audit rows one read will load.
 *
 * A cost bound, not a privacy control — the disclosure filter is that. Chosen
 * high enough that no real owner reaches it in years of ordinary use, and low
 * enough that a box which has been federating hard does not serialize a hundred
 * thousand rows into a GraphQL response.
 */
export const MAX_AUDIT_ROWS = 5_000;

/** Narrowing for a history read. Every field is optional and only ever restricts. */
export interface AuditFilter {
  askerUserId?: string | null;
  peerLinkId?: string | null;
  outcomes?: readonly AskAuditOutcome[];
  from?: Date | null;
  to?: Date | null;
  limit?: number | null;
}

/** How often one grant has been cited as the basis for a disclosure, and when last. */
export interface GrantUsage {
  useCount: number;
  lastUsedAt: Date;
}

export interface ListedAudit {
  rows: AskAudit[];
  /** True when the read hit {@link MAX_AUDIT_ROWS} and older rows exist. */
  truncated: boolean;
}

/**
 * Clamp a caller-supplied limit into [1, MAX_AUDIT_ROWS].
 *
 * A nullish or unreadable value takes the maximum rather than the minimum: this
 * is a completeness surface, and the fail-safe direction for a cost bound is
 * "show everything we are willing to load", not "show one row".
 */
function boundedLimit(limit: number | null | undefined): number {
  if (limit == null || !Number.isFinite(limit)) {
    return MAX_AUDIT_ROWS;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_AUDIT_ROWS);
}

/**
 * Append-only per-ask audit. Exactly one row is written per terminal outcome
 * (answered / auto_answered / declined / expired) — declines included, since a
 * refused ask proves the gate works. Backs the Disclosure History surface.
 */
@Injectable()
export class AskAuditService {
  constructor(
    @InjectRepository(AskAuditEntity)
    private readonly auditRepository: Repository<AskAuditEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AskAuditService.name);
  }

  /**
   * Record the outcome of an ask.
   *
   * `manager` enrolls the write in a caller-owned transaction, so the audit and
   * the answer it describes commit together or not at all. Omitted, the write
   * runs on its own connection exactly as before.
   */
  async record(data: RecordAskAuditDto, manager?: EntityManager): Promise<AskAudit> {
    const repository = this.repository(manager);
    const record = repository.create({
      id: uuidv7(),
      askId: data.askId,
      askerUserId: data.askerUserId,
      peerLinkId: data.peerLinkId ?? null,
      peerHandle: data.peerHandle ?? null,
      responderUserId: data.responderUserId,
      query: data.query,
      consentBasis: data.consentBasis ?? null,
      outcome: data.outcome,
      disclosedEntities: data.disclosedEntities ?? [],
      // The magnitude, not the itemization. `disclosedEntities` is empty for
      // every form but `retrieval`, so deriving the count from it audited a
      // real `count`/`boolean` disclosure as "nothing was shared" — see
      // {@link AskAuditEntity.disclosedCount}. The itemized length is the
      // FALLBACK, not the source: it is correct for `retrieval` and for the
      // outcomes that disclose nothing, and wrong for exactly the forms this
      // field exists to record.
      disclosedCount: data.disclosedCount ?? data.disclosedEntities?.length ?? 0,
      backingEntities: data.backingEntities ?? [],
    });
    const entity = await repository.save(record);

    return AskAuditEntity.toEgressType(entity);
  }

  /**
   * The caller's disclosure history (asks they responded to), newest first.
   *
   * ═══ THE CAP IS A COST BOUND, AND IT IS NOT SILENT ═══
   *
   * This used to be an unbounded `find`. One standing grant answering twice a
   * day writes some seven hundred rows a year, and every one of them was loaded
   * and shipped to the client on every visit to the history tab.
   *
   * {@link MAX_AUDIT_ROWS} bounds that, and {@link ListedAudit.truncated} is
   * what keeps the bound honest — the same argument `AskExecutorService` makes
   * about its own cap: a silent one turns "everything you have shared" into
   * "the part of it we felt like loading", on the one surface whose entire
   * purpose is completeness.
   */
  async listForResponder(context: UserServiceContext, filter: AuditFilter = {}): Promise<ListedAudit> {
    const where: FindOptionsWhere<AskAuditEntity> = { responderUserId: context.userId };

    // Counterparty narrowing. The two ids are mutually exclusive on a row, so
    // this is an equality filter rather than an OR — see `counterpartyOf`.
    if (filter.askerUserId != null) {
      where.askerUserId = filter.askerUserId;
    }

    if (filter.peerLinkId != null) {
      where.peerLinkId = filter.peerLinkId;
    }

    if (filter.outcomes != null && filter.outcomes.length > 0) {
      where.outcome = In([...filter.outcomes]);
    }

    if (filter.from != null && filter.to != null) {
      where.createdAt = Between(filter.from, filter.to);
    } else if (filter.from != null) {
      where.createdAt = MoreThanOrEqual(filter.from);
    } else if (filter.to != null) {
      where.createdAt = LessThanOrEqual(filter.to);
    }

    const limit = boundedLimit(filter.limit);

    // One row over the limit, so "is there more" is answered by the read itself
    // rather than by a second COUNT that could disagree with it.
    const rows = await this.auditRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit + 1,
    });

    const truncated = rows.length > limit;

    return { rows: rows.slice(0, limit).map(AskAuditEntity.toEgressType), truncated };
  }

  /**
   * The caller's disclosure history folded BY RELATIONSHIP.
   *
   * Reads the same bounded set as {@link listForResponder} and folds it with
   * {@link summarizeDisclosures} — deliberately ONE implementation of the
   * arithmetic rather than a SQL `GROUP BY` beside a TypeScript one. Two copies
   * of "how much has Ana received" drift, and the drift would be invisible
   * because each looks right on its own.
   *
   * `truncated` propagates for the same reason it does there: a total computed
   * over a truncated set is not a total, and the surface has to be able to say
   * so.
   */
  async summaryForResponder(
    context: UserServiceContext,
    options: { now?: Date; windowMs?: number; limit?: number } = {},
  ): Promise<{ summaries: DisclosureSummary[]; truncated: boolean }> {
    const { rows, truncated } = await this.listForResponder(context, { limit: options.limit });

    return {
      summaries: summarizeDisclosures(rows, { now: options.now, windowMs: options.windowMs }),
      truncated,
    };
  }

  /**
   * How much each of the caller's grants has actually been USED.
   *
   * ═══ A GRANT MANAGER THAT CANNOT SAY THIS IS HALF A CONTROL ═══
   *
   * The matrix shows what an owner ALLOWED. It has never shown whether anything
   * came of it — so a grant firing daily and one that has never once matched
   * look identical, and they call for opposite actions. The dormant one is
   * clutter to tidy up; the busy one is the thing to look at twice.
   *
   * Computed from `ci.ask_audit.consent_basis`, which is the grant id the
   * disclosure actually cited. NOT from the grants table: a grant's own row
   * records what it permits, never what it did.
   *
   * ONE PASS over the bounded read, folded in memory, rather than a `GROUP BY`
   * — the same choice `summaryForResponder` makes and for the same reason. Two
   * implementations of "how often did this grant fire" would drift, and the
   * drift would be invisible because each looks right alone.
   */
  async usageByGrant(context: UserServiceContext): Promise<Map<string, GrantUsage>> {
    const { rows } = await this.listForResponder(context);
    const usage = new Map<string, GrantUsage>();

    for (const row of rows) {
      const basis = row.consentBasis;
      if (basis == null) {
        continue;
      }

      const existing = usage.get(basis);
      if (existing == null) {
        usage.set(basis, { useCount: 1, lastUsedAt: row.createdAt });

        continue;
      }

      existing.useCount += 1;
      if (row.createdAt > existing.lastUsedAt) {
        existing.lastUsedAt = row.createdAt;
      }
    }

    return usage;
  }

  /**
   * The transaction's repository when one is supplied, otherwise the injected
   * one. `manager.getRepository` is what binds the write to the caller's
   * transaction — the injected repository has its own connection and would
   * commit independently, which is exactly the split this exists to close.
   */
  private repository(manager?: EntityManager): Repository<AskAuditEntity> {
    return manager ? manager.getRepository(AskAuditEntity) : this.auditRepository;
  }
}
