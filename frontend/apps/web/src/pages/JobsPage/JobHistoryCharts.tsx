import { useMemo, useState, type ReactNode } from 'react';

import { Button, Card, Skeleton, cn } from '@ci/shadcn';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';

import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';

import { FoldBody, FoldCard, FoldTrigger, cardPad, usePhone } from './Fold';
import { categoryChartColor, categoryLabel } from './jobCategories';
import { useJobCategoryHistory, type JobCategoryHistoryResponse } from './useJobCategoryHistory';
import { HISTORY_WINDOWS, type JobHistoryPoint, type JobHistoryResponse } from './useJobHistory';

type Props = {
  data: JobHistoryResponse | null;
  loading: boolean;
  error: string | null;
  windowHours: number;
  onWindowChange: (hours: number) => void;
  queue: string;
};

/**
 * What the queues have been doing over time.
 *
 * Three charts because there are three genuinely different questions, and one
 * chart type cannot answer them together:
 *
 *  - **Backlog (area)** — a GAUGE. "Is the queue draining or growing?" Only
 *    answerable against its own past, which is the entire reason
 *    `ci.job_metrics` exists.
 *  - **Throughput (bars)** — a DELTA. "How much settled, and how much of it
 *    failed?" Stacked, so the failure share is visible rather than being a
 *    second line to mentally subtract.
 *  - **Latency (line)** — "How long is a job taking?" Mean and p95 together,
 *    because a mean alone hides the tail that actually hurts: on this appliance
 *    image-description averages ~33s while search-index averages ~0.5s, and one
 *    aggregate number across both is meaningless.
 */
const CHARTS = [
  { key: 'backlog', title: 'Backlog' },
  { key: 'throughput', title: 'Throughput' },
  { key: 'duration', title: 'Duration' },
] as const;

type ChartKey = (typeof CHARTS)[number]['key'];

export function JobHistoryCharts({ data, loading, error, windowHours, onWindowChange, queue }: Props) {
  const phone = usePhone();
  const [activeChart, setActiveChart] = useState<ChartKey>('backlog');
  const points = useMemo(() => (data?.points ?? []).map(toChartPoint), [data?.points]);

  const hasThroughput = points.some((point) => point.completed > 0 || point.failed > 0);
  const hasBacklog = points.some((point) => point.backlog > 0);
  const hasLatency = points.some((point) => point.avgSeconds != null || point.p95Seconds != null);

  const windowButtons = (
    <div className="flex flex-wrap gap-1" role="group" aria-label="History window">
      {HISTORY_WINDOWS.map((option) => (
        <Button
          key={option.hours}
          size="sm"
          variant={option.hours === windowHours ? 'secondary' : 'ghost'}
          aria-pressed={option.hours === windowHours}
          onClick={() => onWindowChange(option.hours)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );

  const backlogChart = (
    <ChartPanel
      title="Backlog"
      hint="Jobs waiting, running or retrying. Rising means work is arriving faster than it clears."
      empty={!hasBacklog}
      emptyMessage="No backlog recorded in this window."
    >
      <AreaChart data={points} margin={CHART_MARGIN}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="label" {...AXIS_PROPS} />
        <YAxis {...AXIS_PROPS} width={44} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Legend {...LEGEND_PROPS} />
        <Area
          type="monotone"
          dataKey="pending"
          name="Waiting"
          stackId="backlog"
          stroke="var(--chart-1)"
          fill="var(--chart-1)"
          fillOpacity={0.25}
        />
        <Area
          type="monotone"
          dataKey="active"
          name="Running"
          stackId="backlog"
          stroke="var(--chart-2)"
          fill="var(--chart-2)"
          fillOpacity={0.35}
        />
        <Area
          type="monotone"
          dataKey="retry"
          name="Retrying"
          stackId="backlog"
          stroke="var(--chart-4)"
          fill="var(--chart-4)"
          fillOpacity={0.4}
        />
      </AreaChart>
    </ChartPanel>
  );

  const throughputChart = (
    <ChartPanel
      title="Throughput"
      hint="Jobs that settled in each bucket. The red band is the share that failed."
      empty={!hasThroughput}
      emptyMessage="Nothing settled in this window."
    >
      <BarChart data={points} margin={CHART_MARGIN}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="label" {...AXIS_PROPS} />
        {/* Throughput is the one axis that reaches six figures during a
            bulk import — a 44px gutter silently clipped "100000" to
            "00000". Compact notation keeps it narrow AND readable. */}
        <YAxis {...AXIS_PROPS} width={52} allowDecimals={false} tickFormatter={formatCompact} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Legend {...LEGEND_PROPS} />
        <Bar dataKey="completed" name="Completed" stackId="flow" fill="var(--chart-2)" />
        <Bar dataKey="failed" name="Failed" stackId="flow" fill="var(--destructive)" />
      </BarChart>
    </ChartPanel>
  );

  const durationChart = (
    <ChartPanel
      title="Duration"
      hint="How long a job took. p95 alongside the mean, because the mean hides the tail."
      empty={!hasLatency}
      emptyMessage="No timing recorded in this window."
    >
      <LineChart data={points} margin={CHART_MARGIN}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="label" {...AXIS_PROPS} />
        <YAxis {...AXIS_PROPS} width={52} unit="s" />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Legend {...LEGEND_PROPS} />
        <Line
          type="monotone"
          dataKey="avgSeconds"
          name="Mean"
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />
        <Line
          type="monotone"
          dataKey="p95Seconds"
          name="p95"
          stroke="var(--chart-5)"
          strokeWidth={2}
          strokeDasharray="4 3"
          dot={false}
          connectNulls
        />
      </LineChart>
    </ChartPanel>
  );

  const charts: Record<ChartKey, ReactNode> = {
    backlog: backlogChart,
    throughput: throughputChart,
    duration: durationChart,
  };

  return (
    <FoldCard fold>
      <Card.Header
        className={cn(
          'flex gap-2',
          phone ? 'flex-col' : 'flex-col md:flex-row md:items-center md:justify-between',
          cardPad(phone),
        )}
      >
        <FoldTrigger>
          <Card.Title className="text-base">History</Card.Title>
          <Card.Description>
            {queue ? `${queue} — ` : 'All queues — '}
            {data ? `${data.bucketMinutes}-minute buckets` : 'loading'}
          </Card.Description>
        </FoldTrigger>
        {phone ? null : windowButtons}
      </Card.Header>

      <FoldBody>
        <Card.Content className={cn('space-y-4', cardPad(phone))}>
          {phone ? windowButtons : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              Could not load history: {error}
            </p>
          ) : null}

          {loading && !points.length ? (
            <Skeleton className="h-[170px] w-full" />
          ) : !points.length ? (
            <p className="text-sm text-muted-foreground">
              No history recorded yet. Samples are written every 5 minutes — the first points appear once the
              collector has run.
            </p>
          ) : phone ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="History chart">
                {CHARTS.map((chart) => (
                  <Button
                    key={chart.key}
                    size="sm"
                    role="tab"
                    aria-selected={chart.key === activeChart}
                    variant={chart.key === activeChart ? 'secondary' : 'ghost'}
                    onClick={() => setActiveChart(chart.key)}
                  >
                    {chart.title}
                  </Button>
                ))}
              </div>
              {charts[activeChart]}
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-3">
              {backlogChart}
              {throughputChart}
              {durationChart}
            </div>
          )}

          {/* Full width and taller than the three above it, because it carries
              up to eleven series rather than three — and because it answers the
              question the other three cannot: not "is the queue coping" but
              "WHAT has the appliance been doing". A stacked area over the same
              buckets, so the x-axis lines up with the row above. */}
          <CategoryVolumeChart windowHours={windowHours} />
        </Card.Content>
      </FoldBody>
    </FoldCard>
  );
}

/**
 * Job arrivals per category over time.
 *
 * The three charts above are about the queue's HEALTH — is it draining, what
 * settled, how long it took — and none of them says what kind of work any of it
 * was. On a live appliance that matters more than it sounds: 62% of everything
 * is one category (ingest) and four categories are permanently empty, which is
 * invisible in an undifferentiated backlog curve.
 *
 * ARRIVALS, not completions. A queued job has no completion time, so the live
 * half of the series could only ever count arrivals — plotting completions
 * would make the two halves measure different quantities and meet at the ~36h
 * seam with no visible reason for the step. Dead-letter copies are excluded on
 * both sides: pg-boss stamps the copy with a fresh `created_on`, so counting
 * them would draw a burst of new work at the exact moment work started failing.
 */
function CategoryVolumeChart({ windowHours }: { windowHours: number }) {
  const { data, loading, error } = useJobCategoryHistory(windowHours);

  const categories = data?.categories ?? [];
  const points = useMemo(
    () =>
      (data?.points ?? []).map((point) => ({
        label: bucketLabel(point.at),
        ...point.counts,
      })),
    [data?.points],
  );

  // Summed off the response rather than the flattened chart rows: those carry a
  // string `label` alongside the numeric series, so counting them would mean
  // casting a mixed record to Record<string, number> and lying to the compiler.
  const total = (data?.points ?? []).reduce(
    (sum, point) => sum + Object.values(point.counts).reduce((inner, count) => inner + count, 0),
    0,
  );

  return (
    <ChartPanel
      title="Job types over time"
      hint={
        data
          ? `Jobs arriving in each ${data.bucketMinutes}-minute bucket, by category.${sourceNote(data.source)}`
          : 'Jobs arriving in each bucket, by category.'
      }
      empty={!loading && total === 0}
      emptyMessage={
        error
          ? `Could not load category history: ${error}`
          : 'No jobs arrived in this window. Longer ranges rely on the 5-minute sampler, which only has history from when it first ran.'
      }
      heightClass="h-[300px]"
    >
      <AreaChart data={points} margin={CHART_MARGIN}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="label" {...AXIS_PROPS} />
        <YAxis {...AXIS_PROPS} width={52} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Legend {...LEGEND_PROPS} />
        {categories.map((category) => (
          <Area
            key={category}
            type="monotone"
            dataKey={category}
            name={categoryLabel(category)}
            stackId="categories"
            stroke={categoryChartColor(category)}
            fill={categoryChartColor(category)}
            fillOpacity={0.35}
          />
        ))}
      </AreaChart>
    </ChartPanel>
  );
}

/** Says which store answered, because exact and sampled differ in kind. */
function sourceNote(source: JobCategoryHistoryResponse['source']): string {
  if (source === 'live') {
    return ' Counted directly from the queue.';
  }

  if (source === 'metrics') {
    return ' From 5-minute samples — only as complete as the collector’s uptime.';
  }

  return ' Recent buckets counted directly; older ones from 5-minute samples.';
}

const CHART_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 };

const AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 11, fill: 'var(--muted-foreground)' },
} as const;

const LEGEND_PROPS = {
  verticalAlign: 'bottom',
  height: 24,
  wrapperStyle: { fontSize: 11 },
} as const;

function ChartPanel({
  title,
  hint,
  empty,
  emptyMessage,
  children,
  // Default matches the three side-by-side charts. The category chart overrides
  // it: eleven stacked series in 170px is a band of colour, not a reading.
  heightClass = 'h-[170px]',
}: {
  title: string;
  hint: string;
  empty: boolean;
  emptyMessage: string;
  children: React.ReactElement;
  heightClass?: string;
}) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-medium leading-tight">{title}</h3>
      <p className="mb-1.5 text-xs leading-snug text-muted-foreground">{hint}</p>
      {empty ? (
        <div
          className={cn(
            'flex items-center justify-center rounded-lg border border-dashed border-border/60',
            heightClass,
          )}
        >
          <p className="text-xs text-muted-foreground">{emptyMessage}</p>
        </div>
      ) : (
        <ChartContainer config={{}} className={cn('w-full', heightClass)}>
          {children}
        </ChartContainer>
      )}
    </div>
  );
}

type ChartPoint = {
  label: string;
  pending: number;
  active: number;
  retry: number;
  backlog: number;
  completed: number;
  failed: number;
  avgSeconds: number | null;
  p95Seconds: number | null;
};

/** One bucket's x-axis label. Shared, so the two charts' axes cannot disagree. */
function bucketLabel(at: string): string {
  const date = new Date(at);

  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}

function toChartPoint(point: JobHistoryPoint): ChartPoint {
  return {
    label: bucketLabel(point.at),
    pending: point.pending,
    active: point.active,
    retry: point.retry,
    backlog: point.pending + point.active + point.retry,
    completed: point.completed,
    failed: point.failed,
    // Seconds, not milliseconds: a queue whose jobs take half a minute reads as
    // "33" rather than "33546", and the axis stays legible next to a queue
    // whose jobs take half a second.
    avgSeconds: point.avgDurationMs == null ? null : round(point.avgDurationMs / 1000),
    p95Seconds: point.p95DurationMs == null ? null : round(point.p95DurationMs / 1000),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 79,913 → "80K". Keeps a six-figure import inside a narrow axis gutter. */
function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
