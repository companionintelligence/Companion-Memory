import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ActionEntity } from '@ci/domains/intelligence';
import {
  estimateActivityDurationMinutes,
  PersonalizationService,
  PlacementService,
} from '@ci/domains/personalization';
import { SummaryEntity } from '@ci/domains/summaries';

import { EventCandidateEntity, type RationaleSource } from '../entities/EventCandidateEntity';
import type { CreateCandidateDto } from '../types';

import { CandidateService } from './CandidateService';

/** Cap per source so one noisy generator cannot flood the slate. */
const MAX_PER_SOURCE = 25;

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

    const proposals = [
      ...(await this.fromActions(context, windowStart, windowEnd)),
      ...(await this.fromInsights(context, windowStart, windowEnd)),
    ];

    if (proposals.length === 0) {
      await this.retireStale(context);

      return 0;
    }

    const written = await this.candidateService.upsert(context, proposals);

    await this.retireStale(context);

    await this.tryAutoAccept(context);

    this.logger.log('Synced schedule suggestions', {
      proposed: proposals.length,
      written: written.length,
    });

    return written.length;
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
  private async tryAutoAccept(context: UserServiceContext): Promise<void> {
    const profile = await this.personalizationService.getProfile(context.userId!);
    if (!profile.autoSchedule) {
      return;
    }

    const open = await this.candidateRepository.find({
      where: { userId: context.userId!, status: 'open' },
      order: { confidence: 'DESC' },
      take: 3,
    });

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

      try {
        const startTime = candidate.windowStart ?? new Date();
        await this.candidateService.accept(context, candidate.id, startTime);
      } catch {
        // Concurrent accept or missing window — skip silently.
      }
    }
  }
}
