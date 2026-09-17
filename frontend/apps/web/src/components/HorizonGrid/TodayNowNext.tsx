import { cn } from '@ci/shadcn';

import type { ScheduleEvent } from '@/api/useScheduleService';
import { detectBrowserTimeZone } from '@/lib/timezone';

import { addDays, formatClock, pickNowNext, sameLocalDay, startOfLocalDay } from './nowNext';
import { zonedDayOfMonth } from './zonedClock';

interface TodayNowNextProps {
  events: readonly ScheduleEvent[];
  day: Date;
  now?: Date;
  /** IANA zone to read the day in — the owner's profile zone on the schedule page. */
  timeZone?: string;
  /** Opens the week grid when the list is truncated. */
  onShowMore?: () => void;
}

function timeLabel(status: 'now' | 'next' | 'later', event: ScheduleEvent, zone: string): string {
  if (status === 'now') {
    return 'Now';
  }

  if (event.isAllDay) {
    return 'All day';
  }

  return formatClock(new Date(event.startTime), zone);
}

/**
 * Today's story, as a short now/next list — the phone substitute for the
 * 360px TimelineJS strip. Tap a row does not need a hover state: time and
 * title are already on the card; "+N more" is a real button.
 */
export function TodayNowNext({ events, day, now = new Date(), timeZone, onShowMore }: TodayNowNextProps) {
  const zone = timeZone ?? detectBrowserTimeZone();
  const { items, remaining, done } = pickNowNext(events, day, now, 3, zone);
  const heading = day.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: zone,
  });
  const lookingAtToday = sameLocalDay(day, now, zone);

  return (
    <section aria-label={heading} className="rounded-lg border border-border bg-card px-3 py-2.5">
      <h3 className="text-sm font-semibold text-foreground">{heading}</h3>

      {items.length === 0 ? (
        <p className="mt-1.5 text-sm leading-snug text-muted-foreground">
          {done && lookingAtToday ? "That's all for today." : 'Nothing on the calendar this day.'}
        </p>
      ) : (
        <ol className="mt-1.5 space-y-1">
          {items.map(({ event, status }) => (
            <li key={event.id} className="flex items-baseline gap-2.5 text-sm">
              <span
                className={cn(
                  'w-14 shrink-0 tabular-nums',
                  status === 'now' ? 'font-semibold text-primary' : 'text-muted-foreground',
                )}
              >
                {timeLabel(status, event, zone)}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">{event.title}</span>
            </li>
          ))}
        </ol>
      )}

      {remaining > 0 &&
        (onShowMore ? (
          <button type="button" onClick={onShowMore} className="mt-1.5 text-xs font-medium text-primary">
            +{remaining} more
          </button>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">+{remaining} more</p>
        ))}
    </section>
  );
}

interface WeekDayChipsProps {
  start: Date;
  days: number;
  selectedDay: Date;
  onSelectDay: (day: Date) => void;
  now?: Date;
  /** IANA zone to read the days in — the owner's profile zone on the schedule page. */
  timeZone?: string;
}

/**
 * Seven day buttons. The week grid's row labels need a pointer hover to feel
 * selected; these are always tappable and always show weekday + date.
 */
export function WeekDayChips({
  start,
  days,
  selectedDay,
  onSelectDay,
  now = new Date(),
  timeZone,
}: WeekDayChipsProps) {
  const zone = timeZone ?? detectBrowserTimeZone();
  const today = startOfLocalDay(now, zone);
  const origin = startOfLocalDay(start, zone);

  return (
    <div role="tablist" aria-label="Days this week" className="flex gap-1">
      {Array.from({ length: days }, (_, index) => {
        const day = addDays(origin, index, zone);
        const selected = sameLocalDay(day, selectedDay, zone);
        const isToday = sameLocalDay(day, today, zone);
        const label = day.toLocaleDateString([], {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          timeZone: zone,
        });

        return (
          <button
            key={day.toISOString()}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={label}
            onClick={() => onSelectDay(day)}
            className={cn(
              'flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center rounded-lg py-1.5',
              'text-center outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected
                ? 'bg-accent text-accent-foreground ring-1 ring-inset ring-primary/40'
                : isToday
                  ? 'bg-accent/40 text-foreground'
                  : 'text-muted-foreground active:bg-accent/30',
            )}
          >
            <span className="text-[10px] font-medium uppercase leading-none tracking-wide">
              {day.toLocaleDateString([], { weekday: 'short', timeZone: zone })}
            </span>
            <span className="mt-1 text-sm font-semibold tabular-nums leading-none">
              {zonedDayOfMonth(day, zone)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
