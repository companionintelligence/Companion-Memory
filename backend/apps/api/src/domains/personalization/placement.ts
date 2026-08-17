import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/memory';
import { isValidTimezone, localDateInTZ, todayInTZ, zonedWallTimeToUTC } from '@ci/domains/planning';

import {
  durationFromSpan,
  estimateActivityDurationMinutes,
  MAX_ACTIVITY_MINUTES,
  MIN_ACTIVITY_MINUTES,
} from './activityDuration';
import { isLocalDate } from './calendarDay';
import type { ContextPromptPlace, ContextPromptSource, ContextPromptWritePlan } from './contextPrompt.types';

export { estimateActivityDurationMinutes } from './activityDuration';

const FLEX_DAYS = 7;

export function shiftLocalDate(date: string, days: number): string {
  const pivot = new Date(`${date}T12:00:00Z`);
  pivot.setUTCDate(pivot.getUTCDate() + days);

  return pivot.toISOString().slice(0, 10);
}

export function flexWindow(timezone: string, now: Date = new Date()): { windowStart: Date; windowEnd: Date } {
  const today = todayInTZ(timezone, now);

  return {
    windowStart: zonedWallTimeToUTC(today, '00:00', timezone),
    windowEnd: zonedWallTimeToUTC(shiftLocalDate(today, FLEX_DAYS), '00:00', timezone),
  };
}

export function placeForSource(source: ContextPromptSource): ContextPromptPlace | undefined {
  if (source.place) {
    return source.place;
  }

  if (source.kind === 'candidate') {
    return 'future_this_week';
  }

  if (source.id === 'last-night') {
    return 'last_night';
  }

  if (source.id && /^night-\d+$/.test(source.id)) {
    return 'further_back';
  }

  return undefined;
}

export function writerFor(source: ContextPromptSource): ContextPromptWritePlan['writer'] {
  const place = placeForSource(source);
  if (place === 'future_this_week' || source.kind === 'candidate') {
    return 'write_schedule_accept';
  }

  if (place === 'last_night' || place === 'further_back') {
    return 'write_event_actual';
  }

  return 'write_answer';
}

/** Yes/No "no" on a named day is a deferral, not a decline of the candidate. */
export function isDayDeferral(response: unknown, source: ContextPromptSource): boolean {
  if (source.kind !== 'candidate' && placeForSource(source) !== 'future_this_week') {
    return false;
  }

  return typeof response === 'string' && (response === 'no' || response === 'not_sure');
}

export function isNegativeResponse(response: unknown): boolean {
  return (
    typeof response === 'string' &&
    (response === 'no' || response === 'not_sure' || response === 'discard' || response === 'false')
  );
}

export function parseTime(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function resolvePlanStart(timezone: string, day?: string, raw?: string, now: Date = new Date()): Date {
  const parsed = parseTime(raw);
  if (isLocalDate(day)) {
    if (parsed && localDateInTZ(parsed, timezone) === day && parsed.getTime() > now.getTime() + 5 * 60_000) {
      return parsed;
    }

    const offered = zonedWallTimeToUTC(day, '10:00', timezone);
    if (offered.getTime() > now.getTime() + 5 * 60_000) {
      return offered;
    }
  }

  if (parsed && parsed.getTime() > now.getTime() + 5 * 60_000) {
    return parsed;
  }

  return zonedWallTimeToUTC(shiftLocalDate(todayInTZ(timezone, now), 1), '10:00', timezone);
}

export function resolveActualStart(
  timezone: string,
  place: ContextPromptPlace | undefined,
  raw?: string,
  nightOffset = 1,
  now: Date = new Date(),
): Date {
  const parsed = parseTime(raw);
  if (parsed && parsed.getTime() < now.getTime() - 5 * 60_000) {
    return parsed;
  }

  const offset = place === 'further_back' ? Math.max(nightOffset, 2) : nightOffset;
  const evening = shiftLocalDate(todayInTZ(timezone, now), -offset);

  return zonedWallTimeToUTC(evening, '20:00', timezone);
}

export function resolveEnd(
  start: Date,
  input: {
    durationMinutes?: number;
    endTime?: string;
    hints?: Array<string | null | undefined>;
    slateMinutes?: number | null;
  },
): Date {
  const fromEnd = parseTime(input.endTime);
  if (fromEnd) {
    const span = durationFromSpan(start, fromEnd);
    if (span) {
      return new Date(start.getTime() + span * 60_000);
    }
  }

  const fromPlan =
    typeof input.durationMinutes === 'number' &&
    input.durationMinutes >= MIN_ACTIVITY_MINUTES &&
    input.durationMinutes <= MAX_ACTIVITY_MINUTES
      ? Math.round(input.durationMinutes)
      : undefined;

  const estimated = estimateActivityDurationMinutes(...(input.hints ?? []));
  const slate = input.slateMinutes && input.slateMinutes !== 30 ? input.slateMinutes : undefined;
  const minutes = fromPlan ?? slate ?? estimated;

  return new Date(start.getTime() + minutes * 60_000);
}

/** Split a last-night answer into distinct activities when the user named more than one. */
export function splitActivities(text: string): string[] {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return ['Activity'];
  }

  const parts = trimmed
    .split(/\s+(?:and then|then went|and went|then)\s+/i)
    .map((part) => part.replace(/^[,.\s]+|[,.\s]+$/g, '').trim())
    .filter((part) => part.length >= 8);

  if (parts.length >= 2) {
    return parts.map((part) => shortTitle(part));
  }

  return [shortTitle(trimmed)];
}

export function shortTitle(text: string, max = 60): string {
  const first = text.split(/[.!?]/)[0]?.trim() || text.trim();
  if (first.length <= max) {
    return first;
  }

  const clipped = first.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');

  return `${(lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
}

export function nightOffsetFromSource(source: ContextPromptSource): number {
  const match = source.id?.match(/^night-(\d+)$/);
  if (match) {
    return Number(match[1]);
  }

  return source.id === 'last-night' || source.place === 'last_night' ? 1 : 2;
}

@Injectable()
export class PlacementService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventService: EventService,
  ) {}

  async timezoneFor(userId: string): Promise<string> {
    const rows = (await this.dataSource.query(`SELECT timezone FROM ci.users WHERE id = $1`, [
      userId,
    ])) as Array<{
      timezone: string | null;
    }>;
    const raw = rows[0]?.timezone?.trim();

    return raw && isValidTimezone(raw) ? raw : 'UTC';
  }

  flexWindow(timezone: string, now: Date = new Date()) {
    return flexWindow(timezone, now);
  }

  async acceptCandidate(
    context: UserServiceContext,
    candidateId: string,
    start: Date,
    timing?: { durationMinutes?: number; endTime?: string },
  ): Promise<void> {
    const rows = (await this.dataSource.query(
      `
      SELECT title, description, duration_minutes, l0_class, rationale, generator
      FROM ci.event_candidates
      WHERE candidate_id = $1 AND user_id = $2 AND status = 'open'
      `,
      [candidateId, context.userId],
    )) as Array<{
      title: string;
      description: string | null;
      duration_minutes: number | null;
      l0_class: string | null;
      rationale: string;
      generator: string | null;
    }>;

    const candidate = rows[0];
    if (!candidate) {
      throw new Error('schedule accept matched no open candidate');
    }

    const end = resolveEnd(start, {
      durationMinutes: timing?.durationMinutes,
      endTime: timing?.endTime,
      hints: [candidate.title, candidate.description],
      slateMinutes: candidate.duration_minutes,
    });

    const [event] = await this.eventService.create(context, {
      title: candidate.title,
      description: candidate.description ?? undefined,
      start_time: start,
      end_time: end,
      category: candidate.l0_class ?? undefined,
      status: 'confirmed',
      is_predicted: false,
      created_by: 'context_prompt:candidate',
      inference_sources: {
        candidate_id: candidateId,
        rationale: candidate.rationale,
        generator: candidate.generator,
      },
    });

    const claimed = (await this.dataSource.query(
      `
      UPDATE ci.event_candidates
      SET status = 'accepted',
          promoted_event_id = $3,
          feedback_at = NOW(),
          snoozed_until = NULL,
          updated_at = NOW()
      WHERE candidate_id = $1 AND user_id = $2 AND status <> 'accepted'
      RETURNING candidate_id
      `,
      [candidateId, context.userId, event.id],
    )) as Array<{ candidate_id: string }>;

    if (claimed.length === 0) {
      await this.eventService.remove(context, event.id);
      throw new Error('schedule accept lost the candidate claim');
    }
  }
}
