import { Card } from '@ci/shadcn';
import { Link } from 'react-router-dom';
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';

import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { labelForSource } from '@/lib/sourceNames';

import { formatCount, formatHours, formatMinorUnits } from './statsFormat';
import type { ConversationRow, LifeInsight, SocialRow, SpendRow, TimeSeries } from './useStatsService';

const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

export function InsightCards({ insights }: { insights: readonly LifeInsight[] }) {
  if (insights.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {insights.map((insight) => {
        const body = (
          <Card.Content className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{insight.title}</span>
            <span className="text-sm font-semibold">{insight.body}</span>
          </Card.Content>
        );

        return insight.href ? (
          <Link key={insight.id} to={insight.href} className="rounded-xl">
            <Card className="h-full transition-colors hover:bg-accent/50">{body}</Card>
          </Link>
        ) : (
          <Card key={insight.id}>{body}</Card>
        );
      })}
    </div>
  );
}

export function SpendChart({ rows }: { rows: readonly SpendRow[] }) {
  return (
    <Card>
      <Card.Header>
        <Card.Title className="text-base">Spending</Card.Title>
        <Card.Description>Outgoing payments — amount, frequency, and typical ticket</Card.Description>
      </Card.Header>
      <Card.Content>
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No parseable payment amounts in this range. Import Venmo, PayPal, or purchase history.
          </p>
        ) : rows.length < 3 ? (
          <MerchantBars rows={rows} />
        ) : (
          <SpendScatter rows={rows} />
        )}
      </Card.Content>
    </Card>
  );
}

function MerchantBars({ rows }: { rows: readonly SpendRow[] }) {
  const max = rows.reduce((best, row) => Math.max(best, row.totalMinor), 0);

  return (
    <div className="flex flex-col">
      {rows.map((row) => {
        const width = max > 0 ? Math.max((row.totalMinor / max) * 100, 0.75) : 0;

        return (
          <div
            key={row.merchant}
            title={`${row.merchant}: ${formatMinorUnits(row.totalMinor, row.currency)} across ${formatCount(row.count)} payments`}
            className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3 rounded-md px-2 py-1.5"
          >
            <span className="truncate text-sm">{row.merchant}</span>
            <div className="h-2.5 rounded-[4px] bg-muted">
              <div
                className="h-full rounded-r-[4px]"
                style={{ width: `${width}%`, backgroundColor: 'var(--chart-2)' }}
              />
            </div>
            <span className="min-w-16 text-right text-xs tabular-nums text-muted-foreground">
              {formatMinorUnits(row.totalMinor, row.currency)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SpendScatter({ rows }: { rows: readonly SpendRow[] }) {
  const data = rows.map((row) => ({
    ...row,
    totalMajor: row.totalMinor / 100,
  }));

  return (
    <ChartContainer
      config={{ spend: { label: 'Spend', color: 'var(--chart-2)' } }}
      className="aspect-auto h-[280px] w-full"
    >
      <ScatterChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="count"
          type="number"
          name="Frequency"
          tickLine={false}
          axisLine={false}
          label={{ value: 'Payments', position: 'insideBottom', offset: -2 }}
        />
        <YAxis
          dataKey="totalMajor"
          type="number"
          name="Amount"
          tickLine={false}
          axisLine={false}
          tickFormatter={(value: number) => formatMinorUnits(Math.round(value * 100))}
          label={{ value: 'Amount', angle: -90, position: 'insideLeft' }}
        />
        <ZAxis dataKey="avgMinor" range={[60, 280]} name="Typical ticket" />
        <ChartTooltip
          cursor={{ strokeDasharray: '3 3' }}
          content={
            <ChartTooltipContent
              hideLabel
              formatter={(_value, _name, item) => {
                const row = item.payload as SpendRow & { totalMajor: number };

                return (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{row.merchant}</span>
                    <span>
                      {formatMinorUnits(row.totalMinor, row.currency)} · {formatCount(row.count)} payments
                    </span>
                  </div>
                );
              }}
            />
          }
        />
        <Scatter data={data} fill="var(--chart-2)" />
      </ScatterChart>
    </ChartContainer>
  );
}

export function TimeChart({ time }: { time: TimeSeries }) {
  const usingHours = time.mode === 'hours';
  const chartRows = usingHours ? time.rows.filter((row) => row.minutes > 0) : time.rows;
  const data = chartRows.map((row, index) => ({
    ...row,
    value: usingHours ? row.minutes : row.count,
    color: PALETTE[index % PALETTE.length],
  }));
  const coverage =
    time.coverage.consideredEvents > 0 ? time.coverage.timedEvents / time.coverage.consideredEvents : 0;

  return (
    <Card>
      <Card.Header>
        <Card.Title className="text-base">How time is spent</Card.Title>
        <Card.Description>
          {usingHours
            ? coverage < 0.25
              ? 'Hours where duration is known — most timeline rows have no duration.'
              : 'Hours from calendar, media, places, travel, and calls'
            : 'Counted events, not hours — most rows have no duration'}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {data.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No calendar, media, place, or travel events in this range.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem] sm:items-center">
            <ChartContainer config={timeChartConfig(data)} className="aspect-auto h-[240px] w-full">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={52}
                  outerRadius={88}
                  paddingAngle={2}
                  stroke="transparent"
                >
                  {data.map((row) => (
                    <Cell key={row.bucket} fill={row.color} />
                  ))}
                </Pie>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      hideLabel
                      formatter={(_value, _name, item) => {
                        const row = item.payload as (typeof data)[number];

                        return (
                          <div className="flex w-full items-center justify-between gap-6">
                            <span>{row.label}</span>
                            <span className="font-medium">
                              {usingHours ? formatHours(row.minutes) : formatCount(row.count)}
                            </span>
                          </div>
                        );
                      }}
                    />
                  }
                />
              </PieChart>
            </ChartContainer>
            <ul className="flex flex-col gap-1.5 text-sm">
              {data.map((row) => (
                <li key={row.bucket} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: row.color }} />
                    <span className="truncate">{row.label}</span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {usingHours ? formatHours(row.minutes) : formatCount(row.count)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

function timeChartConfig(rows: Array<{ bucket: string; label: string; color: string }>): ChartConfig {
  return Object.fromEntries(rows.map((row) => [row.bucket, { label: row.label, color: row.color }]));
}

export function ConversationChart({ rows }: { rows: readonly ConversationRow[] }) {
  const max = rows.reduce((best, row) => Math.max(best, row.count), 0);

  return (
    <Card>
      <Card.Header>
        <Card.Title className="text-base">Conversations</Card.Title>
        <Card.Description>People you message most — inbound vs outbound</Card.Description>
      </Card.Header>
      <Card.Content>
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No messages in this range.</p>
        ) : (
          <div className="flex flex-col">
            {rows.map((row) => {
              const width = max > 0 ? Math.max((row.count / max) * 100, 0.75) : 0;

              return (
                <Link
                  key={row.personId}
                  to={`/people/${row.personId}`}
                  title={`${row.name}: ${formatCount(row.count)} messages (${formatCount(row.inbound)} in · ${formatCount(row.outbound)} out)`}
                  className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
                >
                  <span className="truncate text-sm group-hover:underline">{row.name}</span>
                  <div className="h-2.5 rounded-[4px] bg-muted">
                    <div
                      className="h-full rounded-r-[4px]"
                      style={{ width: `${width}%`, backgroundColor: 'var(--chart-1)' }}
                    />
                  </div>
                  <span className="min-w-14 text-right text-xs tabular-nums text-muted-foreground">
                    {formatCount(row.count)}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

export function SocialChart({
  rows,
  granularity,
}: {
  rows: readonly SocialRow[];
  granularity: 'week' | 'month';
}) {
  const { data, sources } = pivotSocial(rows);
  const config: ChartConfig = Object.fromEntries(
    sources.map((source, index) => [
      source,
      { label: labelForSource(source), color: PALETTE[index % PALETTE.length] },
    ]),
  );

  return (
    <Card>
      <Card.Header>
        <Card.Title className="text-base">Likes, posts, and comments</Card.Title>
        <Card.Description>
          {granularity === 'week' ? 'Weekly' : 'Monthly'} activity by platform. X likes are not imported.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No likes imported yet. Instagram, TikTok, and YouTube exports include them; X likes are not
            imported.
          </p>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-[280px] w-full">
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickFormatter={formatBucketTick} />
              <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {sources.map((source, index) => (
                <Line
                  key={source}
                  type="monotone"
                  dataKey={source}
                  stroke={PALETTE[index % PALETTE.length]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ChartContainer>
        )}
      </Card.Content>
    </Card>
  );
}

function pivotSocial(rows: readonly SocialRow[]): {
  data: Array<Record<string, string | number>>;
  sources: string[];
} {
  const sources = [...new Set(rows.map((row) => row.sourceSystem))];
  const byBucket = new Map<string, Record<string, string | number>>();

  for (const row of rows) {
    const key = row.bucket.slice(0, 10);
    const current = byBucket.get(key) ?? { bucket: key };
    for (const source of sources) {
      if (typeof current[source] !== 'number') {
        current[source] = 0;
      }
    }

    current[row.sourceSystem] = Number(current[row.sourceSystem]) + row.count;
    byBucket.set(key, current);
  }

  return { data: [...byBucket.values()], sources };
}

function formatBucketTick(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parsed);
}
