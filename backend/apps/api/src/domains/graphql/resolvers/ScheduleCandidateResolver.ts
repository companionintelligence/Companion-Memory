import { BadRequestException, ForbiddenException, UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import {
  CandidateService,
  SuggestionSyncService,
  TaskBreakdownService,
  type DeclineReason,
} from '@ci/domains/schedule';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { EventType } from '../types/EventType';
import { GlobalUID } from '../types/GlobalUID';
import { ScheduleCandidateType } from '../types/ScheduleCandidateType';

const DECLINE_REASONS: DeclineReason[] = ['not_now', 'wrong_time', 'not_like_this', 'never'];

/**
 * Validate a caller-supplied decline reason. Unknown values are rejected rather
 * than cast through: `reason` arrives as a String, and only `never` retires an
 * idea permanently, so `'Never'` or a typo used to store a reason no consumer
 * recognises while quietly doing the opposite of what was asked.
 */
function parseDeclineReason(raw: string): DeclineReason {
  if (!(DECLINE_REASONS as string[]).includes(raw)) {
    throw new BadRequestException(
      `Unknown decline reason "${raw}" — expected one of: ${DECLINE_REASONS.join(', ')}`,
    );
  }

  return raw as DeclineReason;
}

/** Decode the GlobalUID clients receive from ScheduleCandidateType.id. */
function parseCandidateId(gid: string): string {
  return GlobalUID.parse('schedule-candidate', gid);
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ScheduleCandidateType)
export class ScheduleCandidateResolver {
  constructor(
    private readonly candidateService: CandidateService,
    private readonly suggestionSyncService: SuggestionSyncService,
    private readonly taskBreakdownService: TaskBreakdownService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ScheduleCandidateResolver.name);
  }

  /**
   * `schedule.page` is a wholesale gate for the Schedule surface, not just its
   * React route — with it off the proposer is still being tuned, so nothing here
   * should read, write, or spend an LLM call for any caller.
   */
  private async isScheduleEnabled(): Promise<boolean> {
    return this.featureService.isFeatureEnabled('schedule.page');
  }

  /**
   * The same gate for the mutations whose return type is non-nullable, which
   * cannot signal "off" with the empty value the read paths use.
   */
  private async assertScheduleEnabled(): Promise<void> {
    if (!(await this.isScheduleEnabled())) {
      throw new ForbiddenException('The schedule surface is disabled');
    }
  }

  @Query(() => [ScheduleCandidateType], {
    description: 'Open schedule candidates whose plausible window overlaps [from, to)',
  })
  async scheduleCandidates(
    @Context() context: RequestContext,
    @Args('from', { type: () => Date }) from: Date,
    @Args('to', { type: () => Date }) to: Date,
  ): Promise<ScheduleCandidateType[]> {
    if (!(await this.isScheduleEnabled())) {
      return [];
    }

    const candidates = await this.candidateService.findInRange(toServiceContext(context), from, to);

    return candidates.map((candidate) => ScheduleCandidateType.toType(candidate));
  }

  @Mutation(() => Int, {
    description:
      'Refresh the slate from current actions and insight key_actions. Idempotent; returns rows written.',
  })
  @GraphqlPrivacy({ destructive: false })
  async syncScheduleSuggestions(@Context() context: RequestContext): Promise<number> {
    if (!(await this.isScheduleEnabled())) {
      return 0;
    }

    return this.suggestionSyncService.sync(toServiceContext(context));
  }

  /**
   * Split a free-text brain dump into candidates on the slate.
   *
   * Writes to the same table every other proposer uses, so the cards behave
   * identically once they land — including that scheduling one still means
   * dragging it onto a day.
   */
  @Mutation(() => [ScheduleCandidateType], {
    description: 'Break free text into schedule candidates. Adds to the slate; schedules nothing.',
  })
  @GraphqlPrivacy({ destructive: false })
  async breakDownTasks(
    @Context() context: RequestContext,
    @Args('text', { type: () => String }) text: string,
  ): Promise<ScheduleCandidateType[]> {
    if (!(await this.isScheduleEnabled())) {
      return [];
    }

    const candidates = await this.taskBreakdownService.breakDown(
      { ...context, ...toServiceContext(context) },
      text,
    );

    this.logger.log('Brain dump split into candidates', { count: candidates.length });

    return candidates.map((candidate) => ScheduleCandidateType.toType(candidate));
  }

  /**
   * Promote a candidate to committed time. This is the only crossing from
   * possible to committed, and it is always an explicit user action — dragging
   * a card onto a day. Nothing auto-accepts.
   */
  @Mutation(() => EventType, { description: 'Accept a candidate at a chosen time, minting a real event' })
  // CandidateService.accept only calls eventService.remove on the losing side of a detected
  // concurrent double-accept — cleaning up the event THIS call just minted, not destroying existing
  // user data. The normal path only creates an event and updates the candidate row.
  @GraphqlPrivacy({ destructive: false })
  async acceptCandidate(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('startTime', { type: () => Date }) startTime: Date,
    @Args('endTime', { type: () => Date, nullable: true }) endTime?: Date,
  ): Promise<EventType> {
    await this.assertScheduleEnabled();

    const candidateId = parseCandidateId(id);

    const { event } = await this.candidateService.accept(
      toServiceContext(context),
      candidateId,
      startTime,
      endTime,
    );

    this.logger.log('Candidate placed on the schedule', { candidateId, eventId: event.id });

    return EventType.toType(event);
  }

  /**
   * The inverse of {@link acceptCandidate}: take a placed task off the calendar
   * and put it back among the possibilities. Only events minted from a
   * candidate qualify — a mirrored calendar row has no candidate to return to.
   */
  @Mutation(() => ScheduleCandidateType, {
    description: 'Return a placed event to the slate, deleting the event it minted',
  })
  // CandidateService.returnToSlate ends in eventService.remove — the SDL description already says
  // "deleting the event it minted". Started with none of the prefixes, so a `write` key refused
  // deleteEvent could delete the same row through here.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async returnEventToSlate(
    @Context() context: RequestContext,
    @Args('eventId', { type: () => ID }) gid: string,
  ): Promise<ScheduleCandidateType> {
    await this.assertScheduleEnabled();

    // EventType.toType hands clients a GlobalUID, and that is exactly what the
    // drag payload sends back. `promoted_event_id` is a uuid column, so passing
    // the encoded id through raised a Postgres 22P02 (a 500) instead of the
    // NotFoundException returnToSlate raises for externally-owned events.
    const eventId = GlobalUID.parse('event', gid);

    const candidate = await this.candidateService.returnToSlate(toServiceContext(context), eventId);

    this.logger.log('Event returned to the slate', { eventId, candidateId: candidate.id });

    return ScheduleCandidateType.toType(candidate);
  }

  @Mutation(() => ScheduleCandidateType, {
    description: 'Reject a candidate. reason: not_now | wrong_time | not_like_this | never',
  })
  // CandidateService.decline only ever updates the candidate's status/reason (never/declined/
  // snoozed); the row and its content stay intact and queryable either way. Flagged as a
  // borderline judgment call: reasons 'never'/'not_like_this' have no un-decline mutation in this
  // schema, but nothing is deleted.
  @GraphqlPrivacy({ destructive: false })
  async declineCandidate(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('reason', { type: () => String, nullable: true, defaultValue: 'not_now' }) reason: string,
  ): Promise<ScheduleCandidateType> {
    await this.assertScheduleEnabled();

    const candidate = await this.candidateService.decline(
      toServiceContext(context),
      parseCandidateId(id),
      parseDeclineReason(reason),
    );

    return ScheduleCandidateType.toType(candidate);
  }

  @Mutation(() => ScheduleCandidateType, { description: 'Defer a candidate until a future instant' })
  @GraphqlPrivacy({ destructive: false })
  async snoozeCandidate(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('until', { type: () => Date }) until: Date,
  ): Promise<ScheduleCandidateType> {
    await this.assertScheduleEnabled();

    const candidate = await this.candidateService.snooze(
      toServiceContext(context),
      parseCandidateId(id),
      until,
    );

    return ScheduleCandidateType.toType(candidate);
  }
}
