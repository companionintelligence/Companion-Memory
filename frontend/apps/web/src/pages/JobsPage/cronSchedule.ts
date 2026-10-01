// Turn a cron expression into columns a person can read.
//
// `0 */15 * * * *` is precise and unreadable; an operator scanning 35 schedules
// wants "how often" and "when", not to parse six positional fields. The raw
// expression stays available (as the cell's title) because it is what you paste
// back into code — this is a second view of it, not a replacement.
//
// Nest emits SIX-field crons (second first). Five-field expressions are accepted
// too, since that is what most people write by hand.
//
// NOTE: these are line comments deliberately. A cron step like `*/15` closes a
// block comment early, which is a genuinely confusing build error to chase.

import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

export interface CronSchedule {
  /** How often it repeats — "Every 15 min", "Hourly", "Daily". */
  readonly frequency: string;
  /** Where in that period it lands — "at :10", "at 04:25", "Mon at 00:15". */
  readonly when: string;
  /** The expression as registered. */
  readonly raw: string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function describeCronExpression(raw: string | null | undefined, fmt: DateTimeFormatter): CronSchedule {
  const expression = (raw ?? '').trim();
  const parts = expression.split(/\s+/).filter(Boolean);

  if (parts.length !== 5 && parts.length !== 6) {
    return { frequency: '—', when: '', raw: expression };
  }

  // Normalize to [second, minute, hour, dayOfMonth, month, dayOfWeek]. A
  // five-field expression has no seconds field, so it starts at minute.
  const [second, minute, hour, dayOfMonth, , dayOfWeek] = parts.length === 6 ? parts : ['0', ...parts];

  const everySeconds = stepOf(second);
  const everyMinutes = stepOf(minute);
  const everyHours = stepOf(hour);

  // Several of these schedules are deliberately staggered by seconds so they do
  // not all fire on the same tick — `30 */5` and `20 */5` are different jobs
  // avoiding each other. Dropping the offset would render them identically and
  // hide the one thing that distinguishes them.
  const offset = /^[0-9]+$/.test(second) && Number(second) > 0 ? `+${Number(second)}s` : '';
  const done = (frequency: string, when = '') => ({
    frequency,
    when: [when, offset].filter(Boolean).join(' '),
    raw: expression,
  });

  // Sub-minute: a step in the seconds field.
  if (everySeconds != null) {
    return done(every(everySeconds, 'sec', 'second'));
  }

  if (everyMinutes != null) {
    return done(every(everyMinutes, 'min', 'minute'));
  }

  if (everyHours != null) {
    return done(every(everyHours, 'hr', 'hour'), minute === '*' ? '' : atMinutes(minute));
  }

  // A wildcard minute with a fixed hour still fires 60x — say so rather than
  // implying it runs once.
  if (minute === '*') {
    return done('Every minute');
  }

  // Fixed minute, wildcard hour → hourly.
  if (hour === '*') {
    return done('Hourly', atMinutes(minute));
  }

  const time = clockOf(hour, minute, fmt);

  if (dayOfWeek !== '*' && dayOfWeek !== '?') {
    return done('Weekly', `${weekdayLabel(dayOfWeek)} at ${time}`);
  }

  if (dayOfMonth !== '*' && dayOfMonth !== '?') {
    return done('Monthly', `${ordinal(dayOfMonth)} at ${time}`);
  }

  return done('Daily', `at ${time}`);
}

// `0,20,40` is three firings an hour, and rendering it raw as `:0,20,40` reads
// as one strange number. Each entry gets its own padded `:mm`.
function atMinutes(field: string): string {
  return `at ${field
    .split(',')
    .map((minute) => `:${pad(minute)}`)
    .join(', ')}`;
}

// The `n` in a `*` + `/n` step, or in a `0-23/n` style range. Null when the
// field is not a step at all.
function stepOf(field: string): number | null {
  const match = /^(?:\*|\d+-\d+)\/(\d+)$/.exec(field);
  if (!match) {
    return null;
  }

  const step = Number(match[1]);

  return Number.isFinite(step) && step > 0 ? step : null;
}

// "Every 15 min", but a step of 1 reads as the plain unit — "Every minute",
// not "Every 1 min". An hourly step gets the idiom people actually use.
function every(value: number, short: string, long: string): string {
  if (value !== 1) {
    return `Every ${value} ${short}`;
  }

  return long === 'hour' ? 'Hourly' : `Every ${long}`;
}

// The time of a fixed-hour schedule. Written the way the cron fields read ("04:25") unless the
// person has chosen an hour cycle, which then applies here like everywhere else ("4:25 AM").
// It is the cron's own wall clock, so no zone is applied. A list or range in either field has
// no single time to write, and stays as written.
function clockOf(hour: string, minute: string, fmt: DateTimeFormatter): string {
  if (fmt.timeFormat === 'auto' || !/^\d+$/.test(hour) || !/^\d+$/.test(minute)) {
    return `${pad(hour)}:${pad(minute)}`;
  }

  return fmt.clock(Number(hour), Number(minute));
}

function pad(field: string): string {
  // A list or range (`0,20,40`) has no single value to pad — show it as written.
  return /^\d+$/.test(field) ? field.padStart(2, '0') : field;
}

function weekdayLabel(field: string): string {
  return field
    .split(',')
    .map((day) => DAYS[Number(day) % 7] ?? day)
    .join(', ');
}

function ordinal(field: string): string {
  if (!/^\d+$/.test(field)) {
    return `day ${field}`;
  }

  const value = Number(field);
  const suffix =
    value % 100 >= 11 && value % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][value % 10] ?? 'th');

  return `${value}${suffix}`;
}
