import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Event, CalendarEventService } from '@ci/domains/memory';

import { EventCandidateEntity, type EventCandidate } from '../entities/EventCandidateEntity';
import { type CreateCandidateDto, type DeclineReason, USER_AUTHORED_GENERATOR_PREFIX } from '../types';

/** Reasons that retire a candidate permanently rather than just for now. */
const PERMANENT_DECLINES: ReadonlySet<DeclineReason> = new Set(['never', 'not_like_this']);

/** Defer durations for reasons that mean "try again later", not "never". */
const DEFERRAL_HOURS: Partial<Record<DeclineReason, number>> = {
  not_now: 24,
  wrong_time: 6,
};

/** Fresh window for a returned candidate whose original one has already closed. */
const RETURNED_WINDOW_DAYS = 7;

/**
 * Something the user typed themselves leads the slate — they asked for it, so
 * it should not queue behind a week of machine suggestions.
 *
 * Done here rather than as a CASE in the ORDER BY for two reasons. The query
 * has no LIMIT and already materialises every matching row, so this is exactly
 * equivalent to sorting in SQL. And it has to hold once a scorer starts
 * populating `fit_score`: hand-written tasks have none, and `NULLS LAST` would
 * otherwise push them to the very back the moment scoring lands.
 *
 * Order WITHIN each group is whatever the query returned, preserved by
 * concatenating two filters rather than sorting.
 */
function partitionUserAuthoredFirst(rows: EventCandidateEntity[]): EventCandidateEntity[] {
  const isUserAuthored = (row: EventCandidateEntity): boolean =>
    row.generator?.startsWith(USER_AUTHORED_GENERATOR_PREFIX) === true;

  const authored = rows.filter(isUserAuthored);

  return authored.length === 0 ? rows : [...authored, ...rows.filter((row) => !isUserAuthored(row))];
}

@Injectable()
export class CandidateService {
  constructor(
    @InjectRepository(EventCandidateEntity)
    private readonly candidateRepository: Repository<EventCandidateEntity>,
    private readonly eventService: CalendarEventService,
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CandidateService.name);
  }

  /**
   * Live candidates whose plausible window overlaps [from, to).
   *
   * Snoozed rows reappear once `snoozed_until` has passed — snoozing is "not
   * now", not a quiet delete, and the user should not have to remember what they
   * deferred.
   */
  async findInRange(context: ServiceContext, from: Date, to: Date): Promise<EventCandidate[]> {
    const query = this.dataSource
      .getRepository(EventCandidateEntity)
      .createQueryBuilder('candidate')
      .where('candidate.window_start < :to', { to })
      .andWhere('candidate.window_end >= :from', { from })
      .andWhere(
        "(candidate.status = 'open' OR (candidate.status = 'snoozed' AND candidate.snoozed_until <= NOW()))",
      )
      .orderBy('candidate.fit_score', 'DESC', 'NULLS LAST')
      // Newest first, so a task just added lands at the front of the rail
      // instead of behind everything already sitting there. Was ASC, which is
      // what made a new card append to the back.
      .addOrderBy('candidate.created_at', 'DESC')
      // Deterministic final tiebreak: two rows can share a created_at, and the
      // order must not shuffle between page loads. candidate_id is uuidv7, so
      // DESC keeps the newest-first reading.
      .addOrderBy('candidate.candidate_id', 'DESC');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('candidate.user_id = :userId', { userId: context.userId });
    }

    const result = await query.getMany();

    return partitionUserAuthoredFirst(result).map((entity) => EventCandidateEntity.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<EventCandidate | null> {
    const entity = await this.candidateRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
    });

    return entity ? EventCandidateEntity.toEgressType(entity) : null;
  }

  /**
   * Upsert proposals by `dedupe_key`.
   *
   * A collision with a row the user already acted on is left untouched: once
   * something is declined, accepted, or snoozed, a later generation run must not
   * resurrect it. Only `open` rows get refreshed with new reasoning.
   *
   * One `INSERT ... ON CONFLICT DO UPDATE ... WHERE status = 'open'` per
   * proposal rather than a read-then-write pair: `event_candidates_dedupe_uniq`
   * is a real unique index, and the schedule page fires a sync on every mount,
   * so two tabs (or a remount racing itself) would otherwise both see no row and
   * both insert — the loser raising an unhandled 23505. The conflict action's
   * WHERE is what carries the do-not-resurrect rule into the database: a
   * collision with a non-open row updates nothing and returns nothing.
   */
  async upsert(context: UserServiceContext, proposals: CreateCandidateDto[]): Promise<EventCandidate[]> {
    const writtenIds: string[] = [];

    for (const proposal of proposals) {
      const rows: Array<{ candidate_id: string }> = await this.candidateRepository.query(
        `INSERT INTO ci.event_candidates AS candidate (
           candidate_id, user_id, title, description, rationale, rationale_sources,
           window_start, window_end, time_flex, duration_minutes, constraints,
           l0_class, l1_cluster_id, energy_cost, dedupe_key, generator, confidence, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'open')
         ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
           title             = EXCLUDED.title,
           description       = EXCLUDED.description,
           rationale         = EXCLUDED.rationale,
           rationale_sources = EXCLUDED.rationale_sources,
           window_start      = EXCLUDED.window_start,
           window_end        = EXCLUDED.window_end,
           time_flex         = EXCLUDED.time_flex,
           duration_minutes  = EXCLUDED.duration_minutes,
           constraints       = EXCLUDED.constraints,
           l0_class          = EXCLUDED.l0_class,
           l1_cluster_id     = EXCLUDED.l1_cluster_id,
           energy_cost       = EXCLUDED.energy_cost,
           generator         = EXCLUDED.generator,
           confidence        = EXCLUDED.confidence,
           updated_at        = NOW()
         WHERE candidate.status = 'open'
         RETURNING candidate_id`,
        [
          uuidv7(),
          context.userId,
          proposal.title,
          proposal.description ?? null,
          proposal.rationale,
          JSON.stringify(proposal.rationale_sources ?? []),
          proposal.window_start,
          proposal.window_end,
          proposal.time_flex ?? 'week',
          proposal.duration_minutes ?? null,
          JSON.stringify(proposal.constraints ?? {}),
          proposal.l0_class ?? null,
          proposal.l1_cluster_id ?? null,
          proposal.energy_cost ?? null,
          proposal.dedupe_key,
          proposal.generator ?? null,
          proposal.confidence ?? null,
        ],
      );

      const id = rows[0]?.candidate_id;

      if (!id) {
        this.logger.debug('Skipping candidate the user already acted on', {
          dedupeKey: proposal.dedupe_key,
        });

        continue;
      }

      writtenIds.push(id);
    }

    if (writtenIds.length === 0) {
      return [];
    }

    // One read for the whole batch, then re-ordered to match the proposals:
    // RETURNING the id alone keeps the write path free of column mapping, and
    // the callers render what came back in the order they asked for it.
    const saved = await this.candidateRepository.find({ where: { id: In(writtenIds) } });
    const byId = new Map(saved.map((entity) => [entity.id, entity]));

    return writtenIds
      .map((id) => byId.get(id))
      .filter((entity): entity is EventCandidateEntity => entity !== undefined)
      .map((entity) => EventCandidateEntity.toEgressType(entity));
  }

  /**
   * Promote a candidate into a real event at a time the user chose.
   *
   * This is the only path from possible to committed, and it is always driven by
   * an explicit user action — there is no auto-accept anywhere in the system.
   * The event is written first so the candidate never claims a promotion that
   * does not exist (the table's promotion-consistency check enforces that
   * direction).
   *
   * The claim on the candidate is a conditional UPDATE, not a save: a
   * double-click sends two acceptCandidate mutations that would both pass a
   * plain in-memory status check and both mint an event, the second overwriting
   * the first's backlink and orphaning a real calendar row nothing points at.
   * Only one UPDATE can move the row onto `accepted`; the loser deletes the
   * event it just minted and fails.
   */
  async accept(
    context: UserServiceContext,
    id: string,
    startTime: Date,
    endTime?: Date,
  ): Promise<{ candidate: EventCandidate; event: Event }> {
    const candidate = await this.candidateRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (!candidate) {
      throw new NotFoundException(`Candidate ${id} not found`);
    }

    if (candidate.status === 'accepted') {
      throw new BadRequestException(`Candidate ${id} was already accepted`);
    }

    const resolvedEnd =
      endTime ??
      (candidate.durationMinutes
        ? new Date(startTime.getTime() + candidate.durationMinutes * 60_000)
        : undefined);

    const [event] = await this.eventService.create(context, {
      title: candidate.title,
      description: candidate.description ?? undefined,
      start_time: startTime,
      end_time: resolvedEnd,
      category: candidate.l0Class ?? undefined,
      energy_level: candidate.energyCost ?? undefined,
      status: 'confirmed',
      // Accepted-from-a-suggestion is a fact about provenance, not a prediction:
      // the user committed to this, so is_predicted stays false and HBPE may
      // train on it like any other real event. inference_sources keeps the trail.
      is_predicted: false,
      created_by: 'schedule:candidate',
      inference_sources: {
        candidate_id: candidate.id,
        rationale: candidate.rationale,
        rationale_sources: candidate.rationaleSources ?? [],
        generator: candidate.generator,
      },
    });

    const promotion = {
      status: 'accepted' as const,
      promotedEventId: event.id,
      feedbackAt: new Date(),
      feedbackReason: null,
      snoozedUntil: null,
    };

    const claim = await this.candidateRepository.update(
      { id, userId: context.userId, status: Not('accepted') },
      promotion,
    );

    if ((claim.affected ?? 0) === 0) {
      // A concurrent accept promoted this candidate while we were minting. The
      // event we just created belongs to nothing, so take it back out rather
      // than leaving an unreturnable row on the user's calendar.
      await this.eventService.remove(context, event.id);

      throw new BadRequestException(`Candidate ${id} was already accepted`);
    }

    this.logger.log('Candidate accepted', { candidateId: candidate.id, eventId: event.id });

    return { candidate: EventCandidateEntity.toEgressType({ ...candidate, ...promotion }), event };
  }

  /**
   * Take a placed task back off the calendar and return it to the slate — the
   * inverse of {@link accept}, and the only way out of committed time that is
   * not a deletion.
   *
   * Scoped to events this system minted from a candidate, found by the
   * `promoted_event_id` backlink. An event mirrored from a synced calendar has
   * no candidate, so it cannot be dragged back: the schedule surface never
   * silently mutates a row another system owns, and un-committing a Google
   * event here would either lie about the source or destroy it.
   */
  async returnToSlate(context: UserServiceContext, eventId: string): Promise<EventCandidate> {
    const candidate = await this.candidateRepository.findOne({
      where: { userId: context.userId, promotedEventId: eventId },
    });

    if (!candidate) {
      throw new NotFoundException(
        `Event ${eventId} did not come from a suggestion, so there is nothing to return it to`,
      );
    }

    // The candidate goes first, in one write that drops `accepted` and the
    // backlink together. Deleting the event first would leave a window in which
    // the row still claims a promotion the event no longer honours — Postgres
    // resolves the ON DELETE SET NULL by updating this row to
    // (accepted, promoted_event_id = NULL), and a crash there strands an
    // accepted candidate that no view surfaces and no path can return.
    // Clearing first fails the other way: the card is back on the slate and the
    // event is still on the calendar, which the user can see and act on.
    candidate.status = 'open';
    candidate.promotedEventId = null;
    candidate.feedbackAt = null;
    candidate.feedbackReason = null;
    candidate.snoozedUntil = null;

    // A candidate whose plausible window has already closed would come back
    // invisible — findInRange only surfaces windows overlapping the view. Give
    // an expired one a fresh week rather than returning it to a grave. A window
    // still open is left alone: it may carry real meaning ("before Friday").
    const now = new Date();
    if (candidate.windowEnd <= now) {
      candidate.windowStart = now;
      candidate.windowEnd = new Date(now.getTime() + RETURNED_WINDOW_DAYS * 86_400_000);
    }

    const saved = await this.candidateRepository.save(candidate);

    await this.eventService.remove(context, eventId);

    this.logger.log('Candidate returned to the slate', { candidateId: candidate.id, eventId });

    return EventCandidateEntity.toEgressType(saved);
  }

  /**
   * Record a rejection. `never` and `not_like_this` retire the idea; `not_now`
   * and `wrong_time` defer via snooze so the slate can surface the card again
   * after a cooling-off period — drag-to-dismiss uses `not_now`, and treating
   * that as a permanent decline made every dismissal behave like "never".
   */
  async decline(context: UserServiceContext, id: string, reason: DeclineReason): Promise<EventCandidate> {
    const deferHours = DEFERRAL_HOURS[reason];

    const candidate = await this.candidateRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (!candidate) {
      throw new NotFoundException(`Candidate ${id} not found`);
    }

    if (candidate.status === 'accepted') {
      throw new BadRequestException(`Candidate ${id} was already accepted`);
    }

    if (deferHours !== undefined) {
      const until = new Date(Date.now() + deferHours * 3_600_000);

      if (until.getTime() <= Date.now()) {
        throw new BadRequestException('`until` must be in the future');
      }

      candidate.status = 'snoozed';
      candidate.snoozedUntil = until;
      candidate.feedbackReason = reason;
      candidate.feedbackAt = new Date();

      const saved = await this.candidateRepository.save(candidate);

      return EventCandidateEntity.toEgressType(saved);
    }

    candidate.status = PERMANENT_DECLINES.has(reason) ? 'never' : 'declined';
    candidate.feedbackReason = reason;
    candidate.feedbackAt = new Date();
    candidate.snoozedUntil = null;

    const saved = await this.candidateRepository.save(candidate);

    return EventCandidateEntity.toEgressType(saved);
  }

  /** Defer a candidate until `until`, after which findInRange surfaces it again. */
  async snooze(context: UserServiceContext, id: string, until: Date): Promise<EventCandidate> {
    if (until.getTime() <= Date.now()) {
      throw new BadRequestException('`until` must be in the future');
    }

    const candidate = await this.candidateRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (!candidate) {
      throw new NotFoundException(`Candidate ${id} not found`);
    }

    if (candidate.status === 'accepted') {
      throw new BadRequestException(`Candidate ${id} was already accepted`);
    }

    candidate.status = 'snoozed';
    candidate.snoozedUntil = until;
    candidate.feedbackReason = 'not_now';
    candidate.feedbackAt = new Date();

    const saved = await this.candidateRepository.save(candidate);

    return EventCandidateEntity.toEgressType(saved);
  }

  /** Persist a how-you'd-do-it compose snapshot on an open candidate. */
  async savePersonalization(
    context: UserServiceContext,
    id: string,
    snapshot: Record<string, unknown>,
  ): Promise<EventCandidate> {
    const candidate = await this.candidateRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (!candidate) {
      throw new NotFoundException(`Candidate ${id} not found`);
    }

    candidate.personalization = {
      ...snapshot,
      generatedAt: new Date().toISOString(),
    };

    const saved = await this.candidateRepository.save(candidate);

    return EventCandidateEntity.toEgressType(saved);
  }
}
