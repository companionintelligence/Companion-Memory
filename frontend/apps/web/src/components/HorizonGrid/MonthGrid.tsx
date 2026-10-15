import { useMemo, type MouseEvent } from 'react';

import { cn } from '@ci/shadcn';

import type { ScheduleEvent } from '@/api/useScheduleService';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import { chipBorder, chipFill, eventColor, type ColorMode } from '@/lib/activityPalette';
import { detectBrowserTimeZone } from '@/lib/timezone';

import { DAYS_IN_WEEK, sameLocalMonth, type CalendarWindow, monthGridDays } from './calendarWindow';
import { EventPeek } from './EventPeek';
import { eventsOnDay, formatClock, sameLocalDay, startOfLocalDay } from './nowNext';
import type { CalendarSlot } from './scheduleGeometry';
import { zonedDayOfMonth } from './zonedClock';

/** Chips drawn in a cell before the rest fold into "+N more". */
const CHIPS_PER_CELL = 3;

interface MonthGridProps {
  window: CalendarWindow;
  events: ScheduleEvent[];
  colorMode?: ColorMode;
  timeZone?: string;
  selectedDay?: Date;
  /** The cell was tapped: this day is the one the slot drawer writes to. */
  onSelectSlot?: (slot: CalendarSlot) => void;
  /** The day's number, or "+N more", was tapped: open that day on its own. */
  onOpenDay?: (dayStart: Date) => void;
  className?: string;
}

function MonthChip({ event, colorMode, zone }: { event: ScheduleEvent; colorMode: ColorMode; zone: string }) {
  const fmt = useDateTimeFormat();
  const color = eventColor(event, colorMode);
  const start = new Date(event.startTime);
  const end = event.endTime ? new Date(event.endTime) : null;
  const clock = event.isAllDay ? 'All day' : formatClock(start, fmt, zone);
  const label = `${event.title}, ${clock}`;

  return (
    <EventPeek
      label={label}
      side="bottom"
      content={
        <div className="max-w-64 space-y-1 text-left">
          <p className="text-xs font-medium">{event.title}</p>
          <p className="text-[11px] tabular-nums opacity-80">
            {event.isAllDay
              ? 'All day'
              : end
                ? `${formatClock(start, fmt, zone)} – ${formatClock(end, fmt, zone)}`
                : formatClock(start, fmt, zone)}
          </p>
          {event.locationName && <p className="text-[11px] opacity-80">{event.locationName}</p>}
        </div>
      }
    >
      <div
        role="listitem"
        data-schedule-chip
        tabIndex={0}
        aria-label={label}
        className={cn(
          'flex min-w-0 items-center gap-1 truncate rounded border px-1 text-[11px] leading-5',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring',
          event.status === 'tentative' && 'border-dashed text-muted-foreground',
        )}
        style={{
          backgroundColor: chipFill(color),
          borderColor: chipBorder(color),
          borderLeftWidth: '3px',
          borderLeftColor: color,
        }}
        onClick={(click: MouseEvent<HTMLDivElement>) => click.stopPropagation()}
      >
        {/* A phone's cell is ~50px: the clock alone filled it and the title
            was cut to nothing. The peek still says when; the chip says what. */}
        {!event.isAllDay && (
          <span className="hidden shrink-0 tabular-nums opacity-75 sm:inline">{clock}</span>
        )}
        <span className="truncate font-medium">{event.title}</span>
      </div>
    </EventPeek>
  );
}

/**
 * A month of days, seven across, each cell listing what is on that day.
 *
 * Same contract as the week grid's lanes: tapping empty cell space selects the
 * day as a slot (all-day, so the drawer writes to the date), the day's number
 * opens the day on its own, and chips peek on hover or tap. Days outside the
 * month are drawn dimmed so the rows stay rectangular.
 */
export function MonthGrid({
  window,
  events,
  colorMode = 'type',
  timeZone,
  selectedDay,
  onSelectSlot,
  onOpenDay,
  className,
}: MonthGridProps) {
  const zone = timeZone ?? detectBrowserTimeZone();
  const today = startOfLocalDay(new Date(), zone);
  const days = useMemo(() => monthGridDays(window, zone), [window, zone]);
  const month = window.month ?? window.span.start;
  const weekdayNames = useMemo(
    () =>
      days
        .slice(0, DAYS_IN_WEEK)
        .map((day) => day.toLocaleDateString([], { weekday: 'short', timeZone: zone })),
    [days, zone],
  );

  return (
    <div
      role="grid"
      aria-label={month.toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: zone })}
      className={cn('flex min-h-0 flex-col overflow-hidden rounded-lg border border-border', className)}
    >
      <div role="row" className="grid shrink-0 grid-cols-7 border-b border-border">
        {weekdayNames.map((name) => (
          <div
            key={name}
            role="columnheader"
            className="py-1.5 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {name}
          </div>
        ))}
      </div>

      <div
        className="grid min-h-0 flex-1 grid-cols-7 overflow-y-auto"
        style={{ gridTemplateRows: `repeat(${window.weeks}, minmax(5.5rem, 1fr))` }}
      >
        {days.map((day, index) => {
          const inMonth = sameLocalMonth(day, month, zone);
          const isToday = sameLocalDay(day, today, zone);
          const isSelected = selectedDay ? sameLocalDay(day, selectedDay, zone) : false;
          const dayEvents = eventsOnDay(events, day, zone);
          const shown = dayEvents.slice(0, CHIPS_PER_CELL);
          const hidden = dayEvents.length - shown.length;
          const dayLabel = day.toLocaleDateString([], {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            timeZone: zone,
          });

          return (
            <div
              key={day.toISOString()}
              role="gridcell"
              aria-label={dayLabel}
              aria-selected={isSelected}
              data-testid="month-day-cell"
              className={cn(
                'flex min-w-0 flex-col gap-0.5 border-b border-border p-1',
                index % DAYS_IN_WEEK !== 0 && 'border-l',
                index >= days.length - DAYS_IN_WEEK && 'border-b-0',
                onSelectSlot && 'cursor-cell',
                !inMonth && 'bg-muted/30',
                isSelected && 'bg-accent/20',
              )}
              onClick={
                onSelectSlot
                  ? (click) => {
                      if ((click.target as HTMLElement).closest('[data-schedule-chip], button')) {
                        return;
                      }

                      onSelectSlot({ instant: day, allDay: true });
                    }
                  : undefined
              }
            >
              <button
                type="button"
                aria-label={`Open ${dayLabel}`}
                onClick={() => onOpenDay?.(day)}
                className={cn(
                  'flex h-6 w-6 items-center justify-center self-start rounded-full text-xs font-semibold tabular-nums',
                  'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                  // The number is a way in, so it has to read as one: the text
                  // takes the accent on hover, not just a faint disc behind it.
                  isToday
                    ? 'bg-primary text-primary-foreground hover:bg-primary/85'
                    : 'hover:bg-muted hover:text-primary',
                  !isToday && !inMonth && 'text-muted-foreground',
                )}
              >
                {zonedDayOfMonth(day, zone)}
              </button>

              {shown.length > 0 && (
                <div role="list" className="flex min-w-0 flex-col gap-0.5">
                  {shown.map((event) => (
                    <MonthChip key={event.id} event={event} colorMode={colorMode} zone={zone} />
                  ))}
                </div>
              )}

              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => onOpenDay?.(day)}
                  className="self-start rounded px-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  +{hidden} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
