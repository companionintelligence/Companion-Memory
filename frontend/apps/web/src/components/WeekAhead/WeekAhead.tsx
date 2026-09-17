import { Fragment } from 'react';

import { cn, Tooltip } from '@ci/shadcn';

import type { DueForecast, DueItem, WeekForecast, WeekForecastCluster } from '@/api/useWeekAheadService';
import { l0Background } from '@/components/ForecastStrip/ForecastStrip';
import { dueItemVisible, weekClusterVisible } from '@/lib/forecastDisplay';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max cluster rows in the grid — rows are the user's own L1 clusters, ranked by peak probability. */
const MAX_ROWS = 8;
/** Max non-overdue items shown in the due list (overdue items always show). */
const MAX_DUE = 5;
/** Keep the grid readable: cells below this probability render near-invisible. */
const MIN_CELL_OPACITY = 0.06;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Short weekday label for a UTC calendar date ("2026-07-10" → "Fri"). */
function dowShort(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
}

interface GridRow {
  clusterId: string;
  name: string;
  l0Class: string;
  /** p_occur per day index; 0 when the cluster is absent from that day's forecast. */
  probs: number[];
  /** True per day when a booked calendar event pins the cell (known, not predicted). */
  scheduled: boolean[];
}

/**
 * Pivot per-day cluster lists into rows. The row set is the union of clusters
 * across the week — entirely organic, whatever behaviors HBPE has discovered
 * for this user — ranked by peak probability and capped at MAX_ROWS.
 */
function buildRows(week: WeekForecast): GridRow[] {
  const rows = new Map<string, GridRow>();

  week.days.forEach((day, dayIdx) => {
    for (const c of day.clusters) {
      let row = rows.get(c.clusterId);
      if (!row) {
        row = {
          clusterId: c.clusterId,
          name: c.name,
          l0Class: c.l0Class,
          probs: week.days.map(() => 0),
          scheduled: week.days.map(() => false),
        };
        rows.set(c.clusterId, row);
      }

      row.probs[dayIdx] = c.pOccur;
      row.scheduled[dayIdx] = c.scheduled;
    }
  });

  return [...rows.values()]
    .filter((row) =>
      weekClusterVisible({
        name: row.name,
        l0Class: row.l0Class,
        pOccur: Math.max(...row.probs),
        scheduled: row.scheduled.some(Boolean),
      }),
    )
    .sort((a, b) => Math.max(...b.probs) - Math.max(...a.probs))
    .slice(0, MAX_ROWS);
}

function daypartSummary(cluster: WeekForecastCluster | undefined): string | null {
  if (!cluster?.daypartProbs.length) {
    return null;
  }

  const top = cluster.daypartProbs.reduce((best, cur) => (cur.probability > best.probability ? cur : best));

  return top.probability >= 0.5 ? `usually ${top.label}` : null;
}

function formatDue(item: DueItem): string {
  // Reconciled against the calendar: a booked instance overrides the prediction.
  if (item.scheduledDate) {
    return `scheduled ${dowShort(item.scheduledDate)}`;
  }

  if (item.overdue) {
    return `${item.daysSinceLast} days since last · usually every ~${Math.round(item.medianIntervalDays)} days`;
  }

  if (item.dueInDays <= 0) {
    return 'due now';
  }

  const [lo, hi] = item.window;
  const range =
    lo != null && hi != null && hi > lo ? ` (${Math.max(0, Math.round(lo))}–${Math.round(hi)} days)` : '';

  return `due in ~${Math.round(item.dueInDays)} days${range}`;
}

// ── Grid cell ─────────────────────────────────────────────────────────────────

function GridCell({
  row,
  day,
  prob,
  scheduled,
}: {
  row: GridRow;
  day: WeekForecast['days'][number];
  prob: number;
  scheduled: boolean;
}) {
  const cluster = day.clusters.find((c) => c.clusterId === row.clusterId);
  const daypart = daypartSummary(cluster);

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>
        <div
          data-l0={row.l0Class}
          className={cn(
            'h-6 rounded-sm cursor-default transition-transform duration-100 hover:scale-110 hover:z-10 relative',
            // A booked event is known, not predicted — ring it and keep it solid.
            scheduled && 'ring-2 ring-inset ring-foreground/60',
          )}
          style={{
            backgroundColor: l0Background(row.l0Class),
            opacity: scheduled ? Math.max(0.85, prob) : Math.max(MIN_CELL_OPACITY, prob),
          }}
        />
      </Tooltip.Trigger>
      <Tooltip.Content side="top" sideOffset={4}>
        <p className="text-xs font-semibold">{row.name}</p>
        <p className="text-[10px] opacity-75">
          {dowShort(day.date)} · {scheduled ? 'on your calendar' : `${Math.round(prob * 100)}% likely`}
          {daypart ? ` · ${daypart}` : ''}
        </p>
      </Tooltip.Content>
    </Tooltip>
  );
}

// ── Due list ──────────────────────────────────────────────────────────────────

function DueRow({ item }: { item: DueItem }) {
  const scheduled = item.scheduledDate != null;

  return (
    <div
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 rounded-md px-2 py-1',
        item.overdue && 'bg-destructive/10 text-destructive',
      )}
    >
      <div
        data-l0={item.l0Class}
        className="w-2 h-2 shrink-0 rounded-sm"
        style={{ backgroundColor: l0Background(item.l0Class) }}
      />
      <span className={cn('flex items-center gap-1 truncate text-xs', item.overdue && 'font-medium')}>
        <span className="truncate">{item.name}</span>
        {scheduled && (
          <span
            className="shrink-0 text-[10px] text-green-600 dark:text-green-500"
            aria-label="on your calendar"
          >
            ✓
          </span>
        )}
      </span>
      <span className={cn('col-start-2 text-[10px]', item.overdue ? 'opacity-90' : 'text-muted-foreground')}>
        {formatDue(item)}
      </span>
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

interface WeekAheadProps {
  week: WeekForecast | null;
  due: DueForecast | null;
  className?: string;
}

/**
 * Week-horizon behavioral forecast card.
 *
 * Extends the ForecastStrip visual grammar (color = L0 class, opacity =
 * probability) from 30-min occupancy out to day-level *occurrence*: rows are
 * the user's own discovered L1 clusters, columns the next 7 days. Beside the
 * grid (below it on mobile), renewal predictions surface what's coming due —
 * and what's overdue, the "it's been 16 days since you saw friends" deviation
 * signal.
 *
 * Reconciled against the calendar: cells backed by a booked event are ringed
 * and solid ("known", not predicted), and a due item with a matching event is
 * reframed as "scheduled ⟨day⟩" rather than a countdown — so the panel never
 * nags about something already on the calendar.
 *
 * Renders nothing until at least one cluster clears the probability floor
 * (recurrence profiles need ~2 weeks of history) — no spinner, no CTA.
 */
export function WeekAhead({ week, due, className }: WeekAheadProps) {
  const rows = week ? buildRows(week) : [];

  if (!week || rows.length === 0) {
    return null;
  }

  const overdue = (due?.due ?? []).filter((d) => d.overdue && dueItemVisible(d));
  const upcoming = (due?.due ?? []).filter((d) => !d.overdue && dueItemVisible(d)).slice(0, MAX_DUE);
  const hasDue = overdue.length > 0 || upcoming.length > 0;

  return (
    <div className={cn('flex flex-col gap-3 md:flex-row md:gap-6', className)}>
      <div
        className="grid gap-0.5 items-center min-w-0 flex-1 md:self-start"
        style={{ gridTemplateColumns: `minmax(0, 7rem) repeat(${week.days.length}, minmax(0, 1fr))` }}
        role="img"
        aria-label="Week-ahead behavioral forecast grid"
      >
        <div />
        {week.days.map((day) => (
          <div key={day.date} className="text-center text-[10px] text-muted-foreground">
            {dowShort(day.date)}
          </div>
        ))}

        {rows.map((row) => (
          <Fragment key={row.clusterId}>
            <div className="pr-2 text-[11px] text-muted-foreground truncate">{row.name}</div>
            {week.days.map((day, dayIdx) => (
              <GridCell
                key={day.date}
                row={row}
                day={day}
                prob={row.probs[dayIdx]}
                scheduled={row.scheduled[dayIdx]}
              />
            ))}
          </Fragment>
        ))}
      </div>

      <div className="space-y-1 border-t border-border pt-2 md:w-80 md:shrink-0 md:border-t-0 md:border-l md:pt-0 md:pl-6">
        <p className="text-[11px] font-medium text-muted-foreground">Coming due</p>
        {hasDue ? (
          <>
            {overdue.map((item) => (
              <DueRow key={item.clusterId} item={item} />
            ))}
            {upcoming.map((item) => (
              <DueRow key={item.clusterId} item={item} />
            ))}
          </>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">All caught up — take a break!</p>
        )}
      </div>
    </div>
  );
}
