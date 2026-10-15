import { useMemo } from 'react';

import { cn } from '@ci/shadcn';

import { detectBrowserTimeZone } from '@/lib/timezone';

import {
  DAYS_IN_WEEK,
  addLocalMonths,
  sameLocalMonth,
  startOfLocalWeek,
  type CalendarWindow,
} from './calendarWindow';
import { sameLocalDay, startOfLocalDay } from './nowNext';
import { zonedAddDays, zonedDayOfMonth } from './zonedClock';

interface YearGridProps {
  window: CalendarWindow;
  timeZone?: string;
  firstDay?: number;
  selectedDay?: Date;
  /** A day was tapped: open it on its own. */
  onOpenDay?: (dayStart: Date) => void;
  /** A month's name was tapped: open that month. */
  onOpenMonth?: (monthStart: Date) => void;
  className?: string;
}

function MiniMonth({
  month,
  zone,
  firstDay,
  today,
  selectedDay,
  onOpenDay,
  onOpenMonth,
}: {
  month: Date;
  zone: string;
  firstDay: number;
  today: Date;
  selectedDay?: Date;
  onOpenDay?: (dayStart: Date) => void;
  onOpenMonth?: (monthStart: Date) => void;
}) {
  const start = startOfLocalWeek(month, zone, firstDay);
  // Six rows always, so the twelve blocks line up whatever the month's shape.
  const days = useMemo(
    () => Array.from({ length: 6 * DAYS_IN_WEEK }, (_, index) => zonedAddDays(start, index, zone)),
    [start, zone],
  );
  const name = month.toLocaleDateString([], { month: 'long', timeZone: zone });

  return (
    <section aria-label={month.toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: zone })}>
      <button
        type="button"
        onClick={() => onOpenMonth?.(month)}
        className="mb-1 rounded px-1 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-muted hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
      >
        {name}
      </button>
      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {days.slice(0, DAYS_IN_WEEK).map((day) => (
          <span key={day.toISOString()} className="text-[10px] font-medium uppercase text-muted-foreground">
            {day.toLocaleDateString([], { weekday: 'narrow', timeZone: zone })}
          </span>
        ))}
        {days.map((day) => {
          if (!sameLocalMonth(day, month, zone)) {
            return <span key={day.toISOString()} aria-hidden="true" />;
          }

          const isToday = sameLocalDay(day, today, zone);
          const isSelected = selectedDay ? sameLocalDay(day, selectedDay, zone) : false;

          return (
            <button
              key={day.toISOString()}
              type="button"
              aria-label={`Open ${day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', timeZone: zone })}`}
              aria-current={isToday ? 'date' : undefined}
              onClick={() => onOpenDay?.(day)}
              className={cn(
                'mx-auto flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums',
                'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                isToday
                  ? 'bg-primary font-semibold text-primary-foreground hover:bg-primary/85'
                  : 'hover:bg-muted hover:text-primary',
                !isToday && isSelected && 'bg-accent text-accent-foreground',
              )}
            >
              {zonedDayOfMonth(day, zone)}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Twelve months at a glance, the way Google's year view does it: dates only,
 * today marked, every day a way into its own view. No events are drawn — a
 * year of them would be unreadable here, and the server caps a single range
 * at a quarter anyway.
 */
export function YearGrid({
  window,
  timeZone,
  firstDay = 0,
  selectedDay,
  onOpenDay,
  onOpenMonth,
  className,
}: YearGridProps) {
  const zone = timeZone ?? detectBrowserTimeZone();
  const today = startOfLocalDay(new Date(), zone);
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, index) => addLocalMonths(window.span.start, index, zone)),
    [window, zone],
  );

  return (
    <div
      aria-label={window.span.start.toLocaleDateString([], { year: 'numeric', timeZone: zone })}
      className={cn('min-h-0 overflow-y-auto', className)}
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {months.map((month) => (
          <MiniMonth
            key={month.toISOString()}
            month={month}
            zone={zone}
            firstDay={firstDay}
            today={today}
            selectedDay={selectedDay}
            onOpenDay={onOpenDay}
            onOpenMonth={onOpenMonth}
          />
        ))}
      </div>
    </div>
  );
}
