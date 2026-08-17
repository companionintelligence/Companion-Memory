/** Shortest block we will write — a standup, not a flicker. */
export const MIN_ACTIVITY_MINUTES = 15;

/** Longest single block — overnight sleep, not a multi-day trip. */
export const MAX_ACTIVITY_MINUTES = 8 * 60;

const DEFAULT_ACTIVITY_MINUTES = 60;

const DURATION_RULES: Array<{ minutes: number; pattern: RegExp }> = [
  { minutes: 480, pattern: /\b(sleep|slept|overnight|all[- ]?nighter)\b/i },
  { minutes: 180, pattern: /\b(hike|hiking|road[- ]?trip|flight|travel day)\b/i },
  { minutes: 150, pattern: /\b(movie|film|cinema|concert|gig|theatre|theater|play)\b/i },
  { minutes: 120, pattern: /\b(baseball|double[- ]?header)\b/i },
  { minutes: 90, pattern: /\b(soccer|football|basketball|hockey|match|game|dinner|restaurant)\b/i },
  { minutes: 75, pattern: /\b(lunch|brunch)\b/i },
  { minutes: 60, pattern: /\b(gym|workout|exercise|run|yoga|class|appointment|meeting)\b/i },
  { minutes: 45, pattern: /\b(coffee|drinks|errand|plan|planning|organize|review)\b/i },
  { minutes: 30, pattern: /\b(standup|stand-up|check[- ]?in|quick call)\b/i },
];

function clampDuration(minutes: number): number {
  return Math.min(MAX_ACTIVITY_MINUTES, Math.max(MIN_ACTIVITY_MINUTES, Math.round(minutes)));
}

/** "2 hours", "2-3 hours", "90 min", "an hour and a half". */
export function parseExplicitDuration(text: string): number | undefined {
  const rangeHours = text.match(/\b(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)\s*hours?\b/i);
  if (rangeHours) {
    return clampDuration(((Number(rangeHours[1]) + Number(rangeHours[2])) / 2) * 60);
  }

  const hours = text.match(/\b(\d+(?:\.\d+)?)\s*hours?\b/i);
  if (hours) {
    return clampDuration(Number(hours[1]) * 60);
  }

  const minutes = text.match(/\b(\d+)\s*(?:minutes?|mins?)\b/i);
  if (minutes) {
    return clampDuration(Number(minutes[1]));
  }

  if (/\ban hour and a half\b/i.test(text)) {
    return 90;
  }

  if (/\b(?:an|one) hour\b/i.test(text)) {
    return 60;
  }

  return undefined;
}

/**
 * Guess how long an activity usually is from title, description, and answer.
 *
 * The slate's 30-minute stamp is a sync default, not a real length — soccer
 * and a movie should not land as half-hour ticks.
 */
export function estimateActivityDurationMinutes(...parts: Array<string | null | undefined>): number {
  const text = parts.filter((part): part is string => Boolean(part?.trim())).join(' ');
  const explicit = parseExplicitDuration(text);
  if (explicit) {
    return explicit;
  }

  for (const rule of DURATION_RULES) {
    if (rule.pattern.test(text)) {
      return rule.minutes;
    }
  }

  if (text.length > 80 && /\band\b/i.test(text)) {
    return 150;
  }

  if (text.length > 80) {
    return 90;
  }

  return DEFAULT_ACTIVITY_MINUTES;
}

export function durationFromSpan(start: Date, end: Date): number | undefined {
  const minutes = (end.getTime() - start.getTime()) / 60_000;
  if (minutes < MIN_ACTIVITY_MINUTES || minutes > MAX_ACTIVITY_MINUTES) {
    return undefined;
  }

  return clampDuration(minutes);
}
