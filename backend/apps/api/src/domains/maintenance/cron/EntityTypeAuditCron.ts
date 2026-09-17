import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { AUDIT_WINDOW_SIZE, EntityTypeAuditService } from '../services/EntityTypeAuditService';

/**
 * 05:35:23 UTC, Sundays.
 *
 *  - **Weekly**, because the thing it catches is a parser fix that has already
 *    landed. A mis-typed row has usually been mis-typed for months; finding it
 *    on Sunday rather than Monday costs nothing, and the window scan is not
 *    something anybody wants nightly.
 *  - **05:35** is past every nightly neighbour — HBPE at 02:30, its bootstrap
 *    sweep at 03:00, the orphan sweep at 02:50, retrieval health at 03:40, the
 *    job-metrics purge at 04:25, the derivation fan-out at 04:40 — so it reads
 *    a settled graph rather than one mid-derivation. It is also a quarter hour
 *    clear of `RecallProbeCron` (05:20), the other weekly Sunday job.
 *  - **Second 23**, not second 0. Twelve schedules already fire on second 0
 *    into one event loop and one 25-connection pool.
 *    `common/schedule/__tests__/cronSecondOffsets.test.ts` names 3, 13, 23, 33,
 *    43, 53 and 58 as free; 13 went to `RecallProbeCron`, and 23 is held by
 *    nothing — no per-minute schedule can land on it, and no other job fires at
 *    this minute and hour.
 */
export const ENTITY_TYPE_AUDIT_CRON = '23 35 5 * * 0';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE JOB THAT REPLACES THE HAND-WRITTEN RETYPE MIGRATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six one-off retype migrations landed in 48 hours (18–19 Aug 2026). Every one
 * of them restated, in SQL, a rule that is already shared TypeScript —
 * `isShortCode` in `import/staging/identity.ts`, read by the iMessage and
 * Google Voice parsers — because a parser fix repairs the next import and
 * nothing re-applies the rule to the rows already in `ci.entities`.
 *
 * This cron is that re-application, on a timer, and it files what it finds as
 * REVIEWABLE PROPOSALS in `ci.entity_type_proposals`.
 *
 * ## It writes nothing to user data. Not in any trust mode.
 *
 * `EntityTypeAuditService` issues no UPDATE against `ci.entities`, no DELETE
 * against `ci_search.*`, and asks the trust dial
 * (`decideAction({ kind: 'graph_entity' })`) per proposal. `graph_entity` is in
 * `GRAPH_CONNECTION_KINDS`, so `cautious` and `balanced` answer `review` at any
 * confidence and only `hands_off` can answer `auto` — and only at or above 0.7,
 * which is exactly why a finding whose key does not prove how the row was
 * minted scores 0.5 and no mode can pre-authorise it. The decision is RECORDED
 * on the proposal (`autonomy`) and obeyed by nobody: there is no applier yet,
 * and this is not it.
 *
 * ## Why the applier is a separate piece of work
 *
 * Applying a retype means, in ONE transaction: move `entity_type`, move
 * `linked_id` (a type change moves the natural key — retyping alone lets the
 * next import mint a duplicate), and delete the `ci_search` and
 * `ci.pipeline_state` rows the row keeps by being a `Person`. The proposal
 * carries all three so the transaction is writable from it; performing it on an
 * unattended timer is the thing this job deliberately does not do.
 *
 * ## Role
 *
 * `role: 'worker'`, like the other maintenance sweeps: it is a windowed scan
 * feeding a review queue, and running it in both processes under a split
 * topology would race two writers onto one `ON CONFLICT` key for no gain.
 */
@Injectable()
export class EntityTypeAuditCron {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly entityTypeAuditService: EntityTypeAuditService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EntityTypeAuditCron.name);
  }

  // `exclusive`: the sweep carries no guard of its own, and a second pass over
  // the same window would race the first onto one `ON CONFLICT` key for nothing.
  @Cron(ENTITY_TYPE_AUDIT_CRON, {
    name: 'EntityTypeAuditCron.auditEntityTypes',
    role: 'worker',
    exclusive: true,
  })
  async auditEntityTypes(): Promise<void> {
    await this.sweep();
  }

  /** @internal Exposed for the spec; the cron body is a one-line delegate. */
  async sweep(windowSize: number = AUDIT_WINDOW_SIZE): Promise<number> {
    const userIds = await this.listOnboardedUserIds();
    let proposed = 0;

    for (const userId of userIds) {
      try {
        const result = await this.entityTypeAuditService.audit(userId, windowSize);

        proposed += result.proposed;
      } catch (error) {
        // Per-user, like every other fan-out here: one account's failed audit is
        // not a reason for the rest to lose the week.
        this.logger.error('Entity type audit failed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log('Entity type audit sweep complete', { users: userIds.length, proposed });

    return proposed;
  }

  /** The same population every other fan-out on this appliance covers. */
  private async listOnboardedUserIds(): Promise<string[]> {
    const rows = (await this.dataSource.query('SELECT id FROM ci.users WHERE onboarded = true')) as Array<{
      id: string;
    }>;

    return rows.map((row) => String(row.id));
  }
}
