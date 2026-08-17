import { localDateInTZ, todayInTZ } from '@ci/domains/planning';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

function shiftLocalDate(date: string, days: number): string {
  const pivot = new Date(`${date}T12:00:00Z`);
  pivot.setUTCDate(pivot.getUTCDate() + days);

  return pivot.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);

  return Math.round((b - a) / 86_400_000);
}

function weekdayIndex(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function ordinal(day: number): string {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) {
    return `${day}th`;
  }

  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** Next occurrence of a weekday name after today, not including today. */
export function nextWeekdayDate(today: string, weekday: string): string | undefined {
  const target = WEEKDAYS.indexOf(weekday.toLowerCase() as (typeof WEEKDAYS)[number]);
  if (target < 0) {
    return undefined;
  }

  const current = weekdayIndex(today);
  const ahead = (target - current + 7) % 7 || 7;

  return shiftLocalDate(today, ahead);
}

/** Thursday / a named weekday in the text, if that day is still ahead in the window. */
export function namedDayInText(text: string, today: string, last: string): string | undefined {
  const match = text.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (!match) {
    return undefined;
  }

  const date = nextWeekdayDate(today, match[1]);
  if (!date || date > last) {
    return undefined;
  }

  return date;
}

/**
 * A concrete local day to offer for a slate card.
 *
 * Never today — answering is not starting the activity. Prefer a weekday the
 * text already named, then tomorrow, then the last day still inside the window.
 */
export function suggestPlanDay(
  timezone: string,
  windowEnd: Date,
  text = '',
  now: Date = new Date(),
): string | undefined {
  const today = todayInTZ(timezone, now);
  const last = localDateInTZ(windowEnd, timezone);
  if (last <= today) {
    return undefined;
  }

  if (/\btomorrow\b/i.test(text)) {
    const tomorrow = shiftLocalDate(today, 1);
    if (tomorrow <= last) {
      return tomorrow;
    }
  }

  const named = namedDayInText(text, today, last);
  if (named) {
    return named;
  }

  const tomorrow = shiftLocalDate(today, 1);
  if (tomorrow <= last) {
    return tomorrow;
  }

  return last;
}

/**
 * How to say the day in a yes/no: "Thursday" this week, "July 31st" further out.
 */
export function formatDayForQuestion(date: string, timezone: string, now: Date = new Date()): string {
  if (!DATE_RE.test(date)) {
    return date;
  }

  const today = todayInTZ(timezone, now);
  const diff = daysBetween(today, date);
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  });

  if (diff >= 1 && diff <= 6) {
    return weekday;
  }

  const month = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
  const day = Number(date.slice(8, 10));

  return `${month} ${ordinal(day)}`;
}

export function isLocalDate(value: string | undefined): value is string {
  return Boolean(value && DATE_RE.test(value));
}

export function calendarQuestion(title: string, dayPhrase?: string): string {
  const clean = cleanCandidateTitle(title);
  if (dayPhrase) {
    return `Want me to put "${clean}" on your calendar for ${dayPhrase}?`;
  }

  return `Want me to put "${clean}" on your calendar this week?`;
}

export function looksLikeGapNote(prompt: string): boolean {
  const text = prompt.trim();

  return (
    /^(you have coming up:|i have a plan for you|i have nothing useful|i do not know|hbpe predicted|you recently said|notes for me)/i.test(
      text,
    ) || !text.includes('?')
  );
}

export function cleanUpcomingTitle(raw: string): string {
  const title = raw
    .replace(/^You have coming up:\s*/i, '')
    .replace(/\s*\([^)]*\d{1,2}:\d{2}[^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return title || 'this';
}

export function upcomingEventQuestion(title: string, dayPhrase?: string): string {
  const clean = cleanUpcomingTitle(title);
  if (dayPhrase) {
    return `Anything I should know about ${clean} on ${dayPhrase}?`;
  }

  return `Anything I should know about ${clean}?`;
}

/** Strip generate-job scaffolding so the spoken question names the card, not the note. */
export function cleanCandidateTitle(raw: string): string {
  const title = raw
    .replace(/^I have a plan for you(?: this week| for [^:]+)?:\s*/i, '')
    .replace(/^Want me to put (?:this on your calendar:\s*)?["']?/i, '')
    .replace(/\s*\([^)]*\d{1,2}:\d{2}[^)]*\)\s*/g, ' ')
    .replace(/["']?\s*on your calendar(?: today| this week| for [^?]+)?[?]?$/i, '')
    .replace(/["']$/g, '')
    .replace(/\?$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return title || 'this';
}
