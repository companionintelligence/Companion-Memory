import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import { assertAskTransition } from '../askStatus';
import { AskEntity } from '../entities/AskEntity';
import type { AskStatus } from '../types';

import { AskAuditService } from './AskAuditService';

/**
 * How many asks one sweep retires. A bound, not a throttle: the sweep runs on
 * the same connection pool the request path uses, and an appliance that has
 * been off for a month must not open a transaction per row for thousands of
 * rows in one tick. Anything left over is picked up by the next run — a few
 * minutes late on an ask that is ALREADY past its deadline costs nothing,
 * because the answer path refuses an expired ask the moment its status lands.
 */
export const EXPIRY_BATCH_SIZE = 200;

/**
 * The statuses an ask can be expired FROM.
 *
 * Deliberately the set of states with an `expired` edge in
 * {@link ASK_TRANSITIONS}, listed rather than derived as "not terminal":
 *
 * - the three terminal states are already decided and must never be reopened;
 * - `sent` has no expiry edge because it does not survive `AskService.create`
 *   (an ask is marked `delivered` in the same call), so a `sent` row past its
 *   deadline is a bug in the creation path, not an expiry the sweep should
 *   paper over by inventing an edge for it.
 *
 * Filtering in SQL rather than throwing on an illegal edge later is what keeps
 * one malformed row from aborting the whole sweep.
 */
export const EXPIRABLE_STATUSES: readonly AskStatus[] = ['delivered', 'under_review', 'answering'];

/**
 * Retires asks that have outlived their `expires_at`.
 *
 * `expired` was in the status union, in the transition table and on the audit
 * outcome enum from the start, and `ci.asks.expires_at` was written by every
 * caller that set one — but NOTHING ever performed the transition. An ask's
 * deadline was therefore decorative, and the consequence was not cosmetic: an
 * ask sitting in `answering` is answerable by definition
 * ({@link isAnswerable}), and `AskService.complete` deliberately does not
 * re-check the standing grant on the owner-approved path (that human decision
 * is not undone by revoking an unrelated grant). So an approved ask whose
 * deadline passed a day ago was a permanent, revocation-immune authorization to
 * disclose in full. This sweep is what makes `expires_at` mean something.
 *
 * Terminal, and therefore idempotent: an expired ask has no outgoing edges, so
 * a second sweep cannot re-expire it and the audit cannot gain a duplicate row.
 */
@Injectable()
export class AskExpiryService {
  constructor(
    @InjectRepository(AskEntity)
    private readonly askRepository: Repository<AskEntity>,
    private readonly auditService: AskAuditService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AskExpiryService.name);
  }

  /**
   * Expire every overdue ask, up to {@link EXPIRY_BATCH_SIZE}. Returns how many
   * were retired.
   *
   * `now` is a parameter so the boundary is testable without moving the system
   * clock; it defaults to the real one.
   *
   * One ask failing does not stop the others. A sweep that abandoned the batch
   * on the first bad row would leave every ask behind it authorized, which is
   * the exact state this exists to end.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const overdue = await this.askRepository.find({
      where: {
        // No `IS NOT NULL` guard is needed: a NULL never satisfies a SQL
        // comparison, so an ask with no deadline is never swept.
        expiresAt: LessThan(now),
        status: In([...EXPIRABLE_STATUSES]),
      },
      order: { expiresAt: 'ASC' },
      take: EXPIRY_BATCH_SIZE,
    });

    let expired = 0;
    for (const ask of overdue) {
      try {
        // Counts only what this sweep actually retired — an ask a responder
        // decided between the scan and the lock is not one of ours.
        if (await this.expire(ask)) {
          expired += 1;
        }
      } catch (err) {
        this.logger.error(
          `Failed to expire ask ${ask.id}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    if (expired > 0) {
      this.logger.log(`Expired ${expired} ask(s) past their deadline`);
    }

    return expired;
  }

  /**
   * Retire one ask and record the terminal outcome ATOMICALLY.
   *
   * Same argument as {@link AskService.completeWithAnswer}: the status change
   * and the audit row are one event recorded twice, and on separate connections
   * they can disagree permanently. Here the disagreement would be an ask the
   * disclosure history never mentions — and `expired` is terminal, so no retry
   * can add the missing row afterwards.
   *
   * The status is re-read inside the transaction with a row lock: the sweep and
   * a responder can reach the same ask at the same moment, and without the lock
   * an ask could be answered and expired in the same instant.
   */
  private async expire(ask: AskEntity): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const locked = await manager.getRepository(AskEntity).findOne({
        where: { id: ask.id },
        lock: { mode: 'pessimistic_write' },
      });

      // Someone answered or declined it between the scan and the lock. Their
      // decision wins — a real outcome beats a deadline.
      if (locked == null || !EXPIRABLE_STATUSES.includes(locked.status)) {
        return false;
      }

      locked.status = assertAskTransition(locked.status, 'expired');
      const saved = await manager.getRepository(AskEntity).save(locked);

      await this.auditService.record(
        {
          askId: saved.id,
          askerUserId: saved.askerUserId,
          peerLinkId: saved.peerLinkId,
          responderUserId: saved.responderUserId,
          query: saved.query,
          consentBasis: saved.consentBasis,
          outcome: 'expired',
          // Nothing crossed: an expiry is the gate closing, which is exactly
          // the reason declines are audited too.
        },
        manager,
      );

      return true;
    });
  }
}
