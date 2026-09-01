import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { defaultAskExpiry } from '../askDeadline';
import { type AskBroadcast, AskBroadcastEntity } from '../entities/AskBroadcastEntity';
import { type Ask, AskEntity } from '../entities/AskEntity';
import type { AskQuery, GrantDecision } from '../types';

import { AskService } from './AskService';

/**
 * The fewest people that make a question a broadcast.
 *
 * Two. One recipient is an ordinary ask and should stay one — routing it
 * through here would give it a grouping row nothing needs and a second code
 * path to keep in step with the first.
 */
export const MIN_BROADCAST_RECIPIENTS = 2;

/**
 * The most people one question may be put to at once.
 *
 * ═══ THIS IS AN ABUSE CONTROL, NOT A COST BOUND ═══
 *
 * Each recipient is an independent ask that lands in a HUMAN's review inbox.
 * Without a cap, one submit puts one question in front of everybody the asker
 * can address, and the per-asker rate limit does not help: it counts requests,
 * and this is one request. Twenty-five is generous for a family, a household or
 * a project team, and far short of "everyone I have ever been linked to".
 *
 * The pend budget in CI-Server #2364 is the general form of this; until it
 * exists, the cap is what keeps a broadcast from being the cheapest way to
 * flood N inboxes at once.
 */
export const MAX_BROADCAST_RECIPIENTS = 25;

/** One recipient's outcome. The DECISION is internal — see {@link create}. */
export interface BroadcastMember {
  ask: Ask;
  decision: GrantDecision;
}

@Injectable()
export class AskBroadcastService {
  constructor(
    @InjectRepository(AskBroadcastEntity)
    private readonly broadcastRepository: Repository<AskBroadcastEntity>,
    @InjectRepository(AskEntity)
    private readonly askRepository: Repository<AskEntity>,
    private readonly askService: AskService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AskBroadcastService.name);
  }

  /**
   * Put one question to several people, as several independent asks.
   *
   * ═══ EACH RECIPIENT IS EVALUATED ALONE ═══
   *
   * Every ask goes through the ordinary {@link AskService.submit}: the
   * responder's own grants decide it, their own tier caps it, it lands in their
   * own inbox and is audited in their own history. Nothing about the group
   * changes what any one of them discloses, and no responder's posture is
   * affected by another's.
   *
   * ═══ THE DECISIONS ARE RETURNED INTERNALLY AND MUST NOT BE PUBLISHED ═══
   *
   * {@link BroadcastMember.decision} is how the caller knows which asks to run
   * the disclosure pipeline for, exactly as `createAsk` uses it for one ask. It
   * is a read on each responder's grant matrix and must never reach the asker —
   * `CreateAskPayload.decision` is the constant `ASK_ACCEPTED` for precisely
   * this reason, and a broadcast returning N decisions would hand back N
   * probes for the price of one request.
   *
   * ═══ SEQUENTIAL, NOT CONCURRENT ═══
   *
   * Deliberately. Each submit runs a grant evaluation and may run a search in
   * the responder's memory; firing 25 of those at once turns one request into a
   * 25-way fan-out against the box's own database. A broadcast is not
   * latency-critical — the answers arrive over hours — so the cheap, boring
   * loop is the right shape.
   */
  async create(
    context: UserServiceContext,
    data: { responderUserIds: readonly string[]; query: AskQuery; expiresAt?: Date | null },
  ): Promise<{ broadcast: AskBroadcast; members: BroadcastMember[] }> {
    const recipients = normalizeRecipients(context.userId, data.responderUserIds);

    if (recipients.length < MIN_BROADCAST_RECIPIENTS) {
      throw new BadRequestException(
        `A broadcast needs at least ${MIN_BROADCAST_RECIPIENTS} different recipients`,
      );
    }

    if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
      throw new BadRequestException(`A broadcast may not exceed ${MAX_BROADCAST_RECIPIENTS} recipients`);
    }

    // The deadline is decided ONCE and stamped on every child, so recipients
    // are not racing different clocks for the same question. `defaultAskExpiry`
    // applies here for the same reason it does on a single ask: an unanswered
    // ask is an open authorization for exactly as long as it is unanswered.
    const expiresAt = data.expiresAt ?? defaultAskExpiry();

    const broadcast = await this.broadcastRepository.save(
      this.broadcastRepository.create({
        id: uuidv7(),
        askerUserId: context.userId,
        query: data.query,
        expiresAt,
      }),
    );

    const members: BroadcastMember[] = [];

    for (const responderUserId of recipients) {
      // One failure does not sink the rest. A recipient who no longer exists,
      // or whom the asker may not address, is dropped from THIS broadcast --
      // the alternative is that one stale id silently cancels a question the
      // asker meant to put to everybody else.
      try {
        members.push(
          await this.askService.submit(context, {
            responderUserId,
            query: data.query,
            expiresAt,
            broadcastId: broadcast.id,
          }),
        );
      } catch (error) {
        this.logger.warn(`broadcast ${broadcast.id}: recipient skipped (${String(error)})`);
      }
    }

    if (members.length === 0) {
      // Every recipient failed. The grouping row would name a question nobody
      // was asked, so it is removed rather than left as a broadcast of zero.
      await this.broadcastRepository.delete({ id: broadcast.id });
      throw new BadRequestException('None of those recipients could be asked');
    }

    this.logger.log(`broadcast ${broadcast.id} sent to ${members.length} recipients`);

    return { broadcast: AskBroadcastEntity.toEgressType(broadcast), members };
  }

  /**
   * One of the caller's own broadcasts, with its child asks.
   *
   * ASKER-SCOPED. A responder has no business reading a broadcast: it would
   * tell them who else was asked, which is a fact about the ASKER's
   * relationships and a third-party disclosure nobody consented to. Their own
   * ask is theirs to read; the grouping is not.
   */
  async findForAsker(
    context: UserServiceContext,
    id: string,
  ): Promise<{ broadcast: AskBroadcast; asks: Ask[] } | null> {
    const broadcast = await this.broadcastRepository.findOne({
      where: { id, askerUserId: context.userId },
    });

    if (broadcast == null) {
      return null;
    }

    const asks = await this.askRepository.find({
      where: { broadcastId: id },
      order: { createdAt: 'ASC' },
    });

    return {
      broadcast: AskBroadcastEntity.toEgressType(broadcast),
      asks: asks.map(AskEntity.toEgressType),
    };
  }

  /** The caller's own broadcasts, newest first. */
  async listForAsker(context: UserServiceContext): Promise<AskBroadcast[]> {
    const rows = await this.broadcastRepository.find({
      where: { askerUserId: context.userId },
      order: { createdAt: 'DESC' },
    });

    return rows.map(AskBroadcastEntity.toEgressType);
  }

  /** Child asks for several broadcasts at once, so a list view is not an N+1. */
  async asksForBroadcasts(ids: readonly string[]): Promise<Map<string, Ask[]>> {
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.askRepository.find({
      where: { broadcastId: In([...ids]) },
      order: { createdAt: 'ASC' },
    });

    const byBroadcast = new Map<string, Ask[]>();
    for (const row of rows) {
      if (row.broadcastId == null) {
        continue;
      }

      const list = byBroadcast.get(row.broadcastId) ?? [];
      list.push(AskEntity.toEgressType(row));
      byBroadcast.set(row.broadcastId, list);
    }

    return byBroadcast;
  }
}

/**
 * Dedupe, drop the asker, preserve order.
 *
 * DEDUPING IS LOAD-BEARING, not tidiness: `asks_broadcast_responder_uniq`
 * refuses a second ask for the same person in one broadcast, so a duplicated id
 * would fail the insert and — because one failure does not sink the rest — drop
 * that person from the broadcast entirely. Removing the duplicate up front is
 * what keeps them in it.
 *
 * The asker is dropped rather than rejected: selecting yourself in a group
 * picker is a slip, not an attack, and `AskService.create` would refuse it with
 * the deliberately indistinguishable "unroutable responder" error that tells
 * the asker nothing about which recipient was the problem.
 *
 * Pure.
 */
export function normalizeRecipients(askerUserId: string, ids: readonly string[]): string[] {
  const seen = new Set<string>();

  return ids.filter((id) => {
    if (typeof id !== 'string' || id.trim() === '' || id === askerUserId || seen.has(id)) {
      return false;
    }

    seen.add(id);

    return true;
  });
}
