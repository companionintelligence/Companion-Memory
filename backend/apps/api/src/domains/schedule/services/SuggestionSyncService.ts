import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { localDateInTZ, localHourInTZ, zonedWallTimeToUTC } from '@ci/common/time/zoned';
import { ActionEntity } from '@ci/domains/intelligence';
import {
  estimateActivityDurationMinutes,
  PersonalizationService,
  PlacementService,
} from '@ci/domains/personalization';
import { HbpeService } from '@ci/domains/predictions';
import { SummaryEntity } from '@ci/domains/summaries';

import { EventCandidateEntity, type RationaleSource } from '../entities/EventCandidateEntity';
import type { CreateCandidateDto } from '../types';

import { CandidateService } from './CandidateService';

/** Cap per source so one noisy generator cannot flood the slate. */
const MAX_PER_SOURCE = 25;

/**
 * The waking band an auto-accepted block may start inside, as local hours.
 *
 * Auto-accept runs from a queue job as well as from the page, so "soon" has to
 * be qualified: a 03:00 sweep must not commit the user to a 03:05 block.
 */
const AUTO_ACCEPT_FIRST_HOUR = 8;
const AUTO_ACCEPT_LAST_HOUR = 20;

/** Where a block lands when the band has not opened yet, or has closed. */
const AUTO_ACCEPT_OFFERED_TIME = '10:00';

/** Enough lead that a block accepted right now is not already under way. */
const AUTO_ACCEPT_LEAD_MS = 5 * 60_000;

/**
 * The one `feedback_reason` that retires an *idea* rather than one proposal of it.
 *
 * The column's whole value space, as written today:
 *   `not_now` | `wrong_time` | `not_like_this` | `never`  — CandidateService.decline
 *   `not_now`                                             — CandidateService.snooze
 *   `source_dismissed`                                    — retireStale, below
 *   NULL                                                  — accept / returnToSlate
 *
 * Only `never` means "stop having this idea". It has to be read off
 * `feedback_reason` and not off `status`, because `never` and `not_like_this`
 * both land on `status = 'never'` while meaning opposite things: `never`
 * retires the idea, `not_like_this` says the idea is right and only this
 * framing is wrong, so it must stay re-proposable.
 */
const RETIRED_IDEA_REASON = 'never';

/**
 * Normalised identity of an idea, independent of the id it was minted under.
 *
 * `insight:<summary_id>:<index>` dedupe keys are only as stable as the parent
 * insight: regenerate the insight and the same key action comes back under a
 * new summary id, so the ON CONFLICT do-not-resurrect rule in
 * CandidateService.upsert never sees a collision and the retired idea is
 * proposed again. Matching on the text closes that hole.
 *
 * Title *and* detail, because insight key actions routinely share a label
 * ("Pre-Read Prep: …"), and a title-only key would retire an unrelated task.
 * Exact match after normalisation only — nothing fuzzy: a false suppression is
 * invisible to the user, who simply never sees a card they wanted.
 */
function ideaKey(title: string | null | undefined, description: string | null | undefined): string {
  return [title ?? '', description ?? '']
    .map((part) =>
      part
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.!?…]+$/, ''),
    )
    .join('\n')
    .trim();
}

/** ci.actions.priority runs 1..5, low number = urgent. Map onto fit's 0..1, high = better. */
function priorityToFit(priority: number | null): number {
  if (priority == null) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, (6 - priority) / 5));
}

/** Strip markdown emphasis and collapse whitespace. */
function flatten(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * First sentence within `max`, else a word-boundary clip with an ellipsis.
 *
 * Never breaks mid-word: a card reading "follow up with key stakeholders (e.g.,
 * En" looks broken in a way that a clean truncation does not.
 */
function firstSentence(text: string | null, max = 180): string {
  if (!text) {
    return '';
  }

  const flat = flatten(text);

  // A sentence that fits always wins — it is the most complete thing that can
  // be said in the space.
  const sentence = flat.match(new RegExp(`^.{0,${max}}?[.!?](\\s|$)`))?.[0];

  if (sentence) {
    return sentence.trim();
  }

  if (flat.length <= max) {
    return flat;
  }

  const clipped = flat.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');

  return `${(lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
}

/**
 * Split a "Label: detail" key action into a title and its detail.
 *
 * Insight key_actions are written that way almost without exception ("Pre-Read
 * Prep: Draft a brief document…"), and the label is a far better card title
 * than the first 90 characters of the sentence.
 */
function splitLabelled(text: string): { title: string; detail: string } {
  const flat = flatten(text);
  const match = flat.match(/^([^:]{3,60}):\s*(\S.*)$/);

  if (match) {
    return { title: match[1].trim(), detail: match[2].trim() };
  }

  return { title: firstSentence(flat, 90), detail: flat };
}

/**
 * When an auto-accepted candidate should actually start.
 *
 * `window_start` is the earliest EDGE of the seven-day flex window — local
 * midnight today for everything {@link SuggestionSyncService.sync} mints, see
 * `flexWindow` — and never a proposed time. Passing it straight to
 * `CandidateService.accept` minted a `confirmed` 00:00 block, already hours in
 * the past for anyone whose sync ran during the day; and because accept claims
 * the row, the idea was consumed and could not be re-offered at a usable hour.
 * The window only constrains which day the block may not precede. The hour has
 * to come from somewhere else, and this is that somewhere.
 *
 * `notBefore` is the tail of the previous auto-accept in the same pass, so
 * successive blocks queue up rather than collide.
 */
function autoAcceptStart(timezone: string, windowStart: Date | null, now: Date, notBefore: Date): Date {
  const earliest = new Date(
    Math.max(now.getTime() + AUTO_ACCEPT_LEAD_MS, notBefore.getTime(), windowStart?.getTime() ?? 0),
  );
  const hour = localHourInTZ(earliest, timezone);

  if (hour >= AUTO_ACCEPT_FIRST_HOUR && hour < AUTO_ACCEPT_LAST_HOUR) {
    return earliest;
  }

  const day = localDateInTZ(earliest, timezone);
  const offered = zonedWallTimeToUTC(day, AUTO_ACCEPT_OFFERED_TIME, timezone);

  if (offered.getTime() >= earliest.getTime()) {
    return offered;
  }

  // Past the band on that day, so the block belongs on the next one. The next
  // date is read back off local noon plus 24 hours rather than by incrementing
  // the string: noon is far enough from either DST boundary that the shift
  // cannot land on the same date or skip one.
  const nextDay = localDateInTZ(
    new Date(zonedWallTimeToUTC(day, '12:00', timezone).getTime() + 24 * 60 * 60_000),
    timezone,
  );

  return zonedWallTimeToUTC(nextDay, AUTO_ACCEPT_OFFERED_TIME, timezone);
}

/**
 * Projects the things the system has already decided are worth doing —
 * `ci.actions` and the `key_actions` of insight summaries — into schedule
 * candidates.
 *
 * This is the no-LLM path to a populated slate. It writes to the same table the
 * proposer will (CI-Server-ka0), so accept / decline / snooze, provenance, and
 * the do-not-resurrect rule all come for free: declining a suggestion here is
 * remembered even though nothing "generated" it.
 *
 * Idempotent by `dedupe_key`, so it is safe to run on every page load.
 */
@Injectable()
export class SuggestionSyncService {
  constructor(
    @InjectRepository(ActionEntity)
    private readonly actionRepository: Repository<ActionEntity>,
    @InjectRepository(SummaryEntity)
    private readonly summaryRepository: Repository<SummaryEntity>,
    @InjectRepository(EventCandidateEntity)
    private readonly candidateRepository: Repository<EventCandidateEntity>,
    private readonly candidateService: CandidateService,
    private readonly personalizationService: PersonalizationService,
    private readonly placement: PlacementService,
    private readonly hbpe: HbpeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SuggestionSyncService.name);
  }

  /**
   * Refresh the slate from current actions and insights.
   *
   * @returns how many candidates were written or refreshed.
   */
  async sync(context: UserServiceContext): Promise<number> {
    const now = new Date();
    const timezone = context.userId ? await this.placement.timezoneFor(context.userId) : 'UTC';
    const { windowStart, windowEnd } = this.placement.flexWindow(timezone, now);

    const proposed = [
      ...(await this.fromActions(context, windowStart, windowEnd)),
      ...(await this.fromInsights(context, windowStart, windowEnd)),
      ...(await this.fromDue(context, windowStart, windowEnd)),
    ];

    if (proposed.length === 0) {
      await this.retireStale(context);

      return 0;
    }

    // An idea the user retired outright never reaches the slate again, whatever
    // id it is minted under this time. An empty result is passed through rather
    // than short-circuited: upsert([]) is a no-op, and retireStale /
    // tryAutoAccept still have work to do on rows already on the slate.
    const proposals = await this.suppressRetiredIdeas(context, proposed);

    const written = await this.candidateService.upsert(context, proposals);

    await this.retireStale(context);

    await this.tryAutoAccept(context, timezone, now);

    this.logger.log('Synced schedule suggestions', {
      proposed: proposed.length,
      suppressed: proposed.length - proposals.length,
      written: written.length,
    });

    return written.length;
  }

  /**
   * Drop proposals for ideas the user has explicitly retired.
   *
   * This is the consumer of `ci.event_candidates.feedback_reason`: every
   * decline writes one and, until now, nothing read it back, so a `never` was
   * only ever honoured for as long as the proposal's `dedupe_key` happened to
   * stay stable.
   *
   * Deliberately narrow. `not_now` and `wrong_time` are deferrals — snooze
   * already handles those, and suppressing on them would delete a card the user
   * asked to see later. `source_dismissed` is not a user verdict at all, so an
   * action that comes back should bring its candidate back with it. Only
   * {@link RETIRED_IDEA_REASON} suppresses.
   *
   * Scoped to this service on purpose: TaskBreakdownService reaches
   * CandidateService.upsert directly for things the user typed themselves, and
   * a hand-written task must never be silently swallowed by an old decline.
   */
  private async suppressRetiredIdeas(
    context: UserServiceContext,
    proposals: CreateCandidateDto[],
  ): Promise<CreateCandidateDto[]> {
    const retired = await this.candidateRepository.find({
      where: { userId: context.userId, feedbackReason: RETIRED_IDEA_REASON },
      select: { id: true, title: true, description: true },
    });

    const retiredKeys = new Set(
      retired.map((row) => ideaKey(row.title, row.description)).filter((key) => key.length > 0),
    );

    if (retiredKeys.size === 0) {
      return proposals;
    }

    const kept = proposals.filter(
      (proposal) => !retiredKeys.has(ideaKey(proposal.title, proposal.description)),
    );

    if (kept.length < proposals.length) {
      this.logger.log('Suppressed proposals for ideas the user retired', {
        suppressed: proposals.length - kept.length,
      });
    }

    return kept;
  }

  /** Live feed actions — already the system's answer to "what should I do next?". */
  private async fromActions(
    context: UserServiceContext,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<CreateCandidateDto[]> {
    const actions = await this.actionRepository.find({
      where: { dismissed: false, user: { id: context.userId } },
      order: { priority: 'ASC', createdAt: 'DESC' },
      take: MAX_PER_SOURCE,
    });

    return actions.map((action) => {
      const sources: RationaleSource[] = [{ kind: 'action', id: action.id }];

      return {
        // A titleless action used to become the literal card "Untitled action",
        // which tells the user nothing and buries the real content in the
        // description. Derive a title from the text the same way insight
        // key_actions already do. A title the source DID supply is respected as
        // given — renaming someone else's row is not ours to do.
        title: action.title?.trim() || splitLabelled(action.text ?? '').title || 'Untitled action',
        description: action.text ?? undefined,
        rationale: firstSentence(action.text) || 'Surfaced in your feed.',
        rationale_sources: sources,
        window_start: windowStart,
        window_end: windowEnd,
        time_flex: 'week' as const,
        duration_minutes: estimateActivityDurationMinutes(action.title, action.text),
        dedupe_key: `action:${action.id}`,
        generator: 'adapter/action',
        confidence: priorityToFit(action.priority),
      };
    });
  }

  /**
   * `key_actions` off insight summaries. One insight yields several concrete
   * next steps, each of which is its own schedulable thing.
   */
  private async fromInsights(
    context: UserServiceContext,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<CreateCandidateDto[]> {
    const insights = await this.summaryRepository.find({
      where: { periodType: 'insight', dismissed: false, userId: context.userId },
      order: { createdAt: 'DESC' },
      take: MAX_PER_SOURCE,
    });

    const proposals: CreateCandidateDto[] = [];

    for (const insight of insights) {
      const content = insight.content ?? {};
      const structured = insight.structuredContext ?? {};
      const keyActions = (content.key_actions ?? structured.key_actions ?? []) as unknown;

      if (!Array.isArray(keyActions)) {
        continue;
      }

      keyActions.forEach((raw, index) => {
        const text = typeof raw === 'string' ? raw : null;

        if (!text?.trim()) {
          return;
        }

        const sources: RationaleSource[] = [
          { kind: 'insight', id: insight.summaryId, note: insight.title ?? undefined },
        ];

        const { title, detail } = splitLabelled(text);

        proposals.push({
          title,
          description: detail,
          // The detail is the because — it says what to actually do and why —
          // with the parent insight named so the trail is followable.
          rationale: insight.title ? `${detail} (from "${insight.title}")` : detail,
          rationale_sources: sources,
          window_start: windowStart,
          window_end: windowEnd,
          time_flex: 'week',
          duration_minutes: estimateActivityDurationMinutes(title, detail),
          dedupe_key: `insight:${insight.summaryId}:${index}`,
          generator: 'adapter/insight',
          confidence: insight.confidenceScore ?? 0.5,
        });
      });
    }

    return proposals;
  }

  /**
   * Renewal due-list → slate. Unscheduled, confident, overdue or due within
   * 3 days. Display names are already anchor-only from HBPE.
   */
  private async fromDue(
    context: UserServiceContext,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<CreateCandidateDto[]> {
    try {
      const due = await this.hbpe.getDueList(context);

      return (due.due ?? [])
        .filter(
          (item) => item.confidence >= 0.6 && (item.overdue || item.due_in_days <= 3) && !item.scheduled_date,
        )
        .slice(0, MAX_PER_SOURCE)
        .map((item) => ({
          title: item.name,
          description: item.overdue
            ? `Usually every ${item.median_interval_days} days; last seen ${item.days_since_last} days ago.`
            : `Typically due in about ${item.due_in_days} days.`,
          rationale: item.overdue
            ? `Usually happens about now — last seen ${item.days_since_last} days ago.`
            : `Typically due in ${item.due_in_days} days.`,
          rationale_sources: [{ kind: 'due' as const, id: item.cluster_id }],
          window_start: windowStart,
          window_end: windowEnd,
          time_flex: 'week' as const,
          duration_minutes: 30,
          l0_class: item.l0_class,
          l1_cluster_id: item.cluster_id,
          dedupe_key: `due:${item.cluster_id}:${item.last_seen}`,
          generator: 'hbpe/due',
          confidence: item.confidence,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Retire open candidates whose source has since been dismissed elsewhere.
   *
   * Dismissing an action in the feed and then finding it still sitting on the
   * schedule would read as the system ignoring you. Only `open` rows are
   * touched: anything the user already acted on keeps its own verdict.
   */
  private async retireStale(context: UserServiceContext): Promise<void> {
    const open = await this.candidateRepository.find({
      where: { userId: context.userId, status: 'open' },
    });

    const adapted = open.filter((c) => c.generator?.startsWith('adapter/'));

    if (adapted.length === 0) {
      return;
    }

    const actionIds = adapted
      .filter((c) => c.dedupeKey.startsWith('action:'))
      .map((c) => c.dedupeKey.slice('action:'.length));

    if (actionIds.length === 0) {
      return;
    }

    const live = await this.actionRepository.find({
      where: { dismissed: false, user: { id: context.userId } },
      select: { id: true },
    });
    const liveIds = new Set(live.map((a) => a.id));

    const stale = adapted.filter(
      (c) => c.dedupeKey.startsWith('action:') && !liveIds.has(c.dedupeKey.slice('action:'.length)),
    );

    for (const candidate of stale) {
      candidate.status = 'declined';
      candidate.feedbackReason = 'source_dismissed';
      candidate.feedbackAt = new Date();
      await this.candidateRepository.save(candidate);
    }

    if (stale.length > 0) {
      this.logger.log('Retired candidates whose source was dismissed', { count: stale.length });
    }
  }

  /** hands_off users with estimate-bearing candidates may auto-accept high-confidence items. */
  private async tryAutoAccept(context: UserServiceContext, timezone: string, now: Date): Promise<void> {
    const profile = await this.personalizationService.getProfile(context.userId!);
    if (!profile.autoSchedule) {
      return;
    }

    const open = await this.candidateRepository.find({
      where: { userId: context.userId!, status: 'open' },
      order: { confidence: 'DESC' },
      take: 3,
    });

    // Carries the end of the last block committed in this pass, so a run of
    // auto-accepts comes out as a sequence instead of three confirmed events
    // stacked on one instant.
    let notBefore = now;

    for (const candidate of open) {
      if (candidate.durationMinutes == null) {
        continue;
      }

      const decision = PersonalizationService.decide(profile, {
        kind: 'schedule_accept',
        confidence: candidate.confidence ?? 0.5,
        hasUserInput: true,
      });

      if (decision !== 'auto') {
        continue;
      }

      const startTime = autoAcceptStart(timezone, candidate.windowStart, now, notBefore);

      try {
        await this.candidateService.accept(context, candidate.id, startTime);
        notBefore = new Date(startTime.getTime() + candidate.durationMinutes * 60_000);
      } catch {
        // Concurrent accept or missing window — skip silently.
      }
    }
  }
}
