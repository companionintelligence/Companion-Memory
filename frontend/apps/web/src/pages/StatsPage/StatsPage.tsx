import { useState } from 'react';

import { usePageTitle } from '@ci/common';
import { Button, Card, Skeleton, ToggleGroup } from '@ci/shadcn';
import { AlertTriangle, CalendarOff, RefreshCcw } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { PageContent } from '@/components/layout';
import { Tag } from '@/components/Tag';

import { DailySeries } from './DailySeries';
import { ConversationChart, InsightCards, SocialChart, SpendChart, TimeChart } from './LifeCharts';
import { groupSourcesByKind } from './sourceLabels';
import { formatCount, formatDay } from './statsFormat';
import {
  DEFAULT_STATS_RANGE,
  STATS_RANGE_LABELS,
  STATS_RANGES,
  rangeToBounds,
  type StatsRange,
} from './statsRange';
import { useStatsService, type MemoryStats } from './useStatsService';

const BAR_COLOR = 'var(--chart-2)';

export function StatsPage() {
  usePageTitle('Stats - Companion Memory');

  const [range, setRange] = useState<StatsRange>(DEFAULT_STATS_RANGE);
  const { data, loading, error, refresh } = useStatsService(range);

  return (
    <>
      <PageContent>
        {error && !data && <ErrorNotice message={error} onRetry={refresh} />}
        {loading && !data && <StatsSkeleton />}
        {data && (
          <div className="flex flex-col gap-4">
            {error && <ErrorNotice message={error} onRetry={refresh} />}
            <StatsBody stats={data} range={range} onRangeChange={setRange} refreshing={loading} />
          </div>
        )}
      </PageContent>
    </>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <Card.Content className="flex items-center gap-3 py-6 text-sm">
        <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
        <span className="text-muted-foreground">Unable to load stats: {message}</span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void onRetry()}>
          <RefreshCcw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </Card.Content>
    </Card>
  );
}

function StatsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}

function StatsBody({
  stats,
  range,
  onRangeChange,
  refreshing,
}: {
  stats: MemoryStats;
  range: StatsRange;
  onRangeChange: (range: StatsRange) => void;
  refreshing: boolean;
}) {
  const { isFeatureEnabled } = useFeatures();
  const earliest = formatDay(stats.dateRange.earliest);
  const latest = formatDay(stats.dateRange.latest);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold">Life stats</h1>
          <p className="text-sm text-muted-foreground">
            Patterns in spend, time, and conversations for this window.
            {refreshing ? ' Updating…' : ''}
          </p>
        </div>
        <ToggleGroup
          type="single"
          value={range}
          onValueChange={(value) => value && onRangeChange(value as StatsRange)}
          className="justify-start"
        >
          {STATS_RANGES.map((key) => (
            <ToggleGroup.Item key={key} value={key} className="text-xs" aria-label={STATS_RANGE_LABELS[key]}>
              {STATS_RANGE_LABELS[key]}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup>
      </div>

      {isRangeEmpty(stats) && range !== 'all' && (
        <EmptyRangeNotice stats={stats} range={range} onShowAllTime={() => onRangeChange('all')} />
      )}

      <InsightCards insights={stats.insights} />
      <DailySeries {...rangeToBounds(range)} />

      <div className="grid gap-6 lg:grid-cols-2">
        <SpendChart rows={stats.spend.rows} />
        <TimeChart time={stats.time} />
        <ConversationChart rows={stats.conversations.rows} />
        <SocialChart rows={stats.social.rows} granularity={stats.social.granularity} />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Events" value={formatCount(stats.totals.events)} detail="Timeline entries" />
        <StatTile
          label="Entities"
          value={formatCount(stats.totals.entities)}
          detail="People, places, concepts, and more"
        />
        <StatTile
          label="Relationships"
          value={formatCount(stats.totals.relationships)}
          detail="Entity-to-entity links"
        />
        <StatTile
          label="Date range"
          value={
            earliest && latest ? (
              // Each date is atomic; only the arrow is a break opportunity. Left to
              // ordinary spaces the browser broke *inside* a date — "2026-05-" /
              // "08 → 2026-" / "08-05" — which reads as a truncated value rather
              // than a wrapped one, and does it at every width below `lg`.
              <>
                <span className="whitespace-nowrap tabular-nums">{earliest}</span>{' '}
                <span className="whitespace-nowrap tabular-nums">→ {latest}</span>
              </>
            ) : (
              '—'
            )
          }
          detail="Earliest → latest timeline event"
        />
      </div>

      <BarListCard
        title="Entities by type"
        rows={stats.byEntityType.map((row) => ({ label: row.type, count: row.count }))}
      />

      <BarListCard
        title="Entities by tag"
        rows={stats.byTag.map((row) => ({ label: row.label, count: row.count }))}
        getRowHref={(row) => `/memory?tags=${encodeURIComponent(row.label)}`}
        renderLabel={(row) => <Tag text={row.label} className="max-w-full cursor-pointer" />}
        headerAction={
          isFeatureEnabled('tags.page') ? (
            <Link to="/tags" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
              All tags
            </Link>
          ) : undefined
        }
      />

      <BarListCard
        title="Entities by data source"
        description="How each entity reached your memory."
        sections={groupSourcesByKind(stats.bySource).map((group) => ({
          key: group.kind,
          label: group.label,
          rows: group.rows,
        }))}
      />
    </div>
  );
}

/**
 * True when nothing HAPPENED in the selected window — no message on any
 * channel, no payment, no post or like.
 *
 * Deliberately not "every series is empty". `time` counts calendar entries,
 * which are routinely in the FUTURE (this corpus holds events out to
 * 2026-10-15), so a window with nothing but two scheduled meetings in it would
 * never qualify — and that is exactly the window that looks broken. `channels`
 * rather than `conversations` is the message test: it counts every
 * communication, including those whose participants never resolved to a Person,
 * so `channels` empty implies `conversations` empty but not the reverse.
 *
 * The individual charts each say "none in this range", but three of those side
 * by side read as a broken page rather than an empty window — so an empty
 * window says so once, up front, with the way out.
 */
function isRangeEmpty(stats: MemoryStats): boolean {
  return stats.channels.rows.length === 0 && stats.spend.rows.length === 0 && stats.social.rows.length === 0;
}

function EmptyRangeNotice({
  stats,
  range,
  onShowAllTime,
}: {
  stats: MemoryStats;
  range: StatsRange;
  onShowAllTime: () => void;
}) {
  const bounds = rangeToBounds(range);
  const from = formatDay(bounds.from ?? null);
  const to = formatDay(bounds.to ?? null);
  const earliest = formatDay(stats.dateRange.earliest);
  const latest = formatDay(stats.dateRange.latest);

  return (
    <Card>
      <Card.Content className="flex flex-col gap-3 py-6 text-sm sm:flex-row sm:items-center">
        <CalendarOff className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-0.5">
          <span>
            No messages, payments, or posts in the last {STATS_RANGE_LABELS[range].toLowerCase()}
            {from && to ? (
              <>
                {' '}
                (<span className="tabular-nums">{from}</span> → <span className="tabular-nums">{to}</span>)
              </>
            ) : null}
            .
          </span>
          {earliest && latest && (
            <span className="text-muted-foreground">
              Your memory runs <span className="tabular-nums">{earliest}</span> →{' '}
              <span className="tabular-nums">{latest}</span>. The tiles below stay all-time either way.
            </span>
          )}
        </div>
        <Button variant="outline" size="sm" className="sm:ml-auto" onClick={onShowAllTime}>
          Show all time
        </Button>
      </Card.Content>
    </Card>
  );
}

interface StatTileProps {
  label: string;
  value: React.ReactNode;
  detail: string;
}

function StatTile({ label, value, detail }: StatTileProps) {
  return (
    <Card>
      <Card.Content className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-lg font-semibold">{value}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </Card.Content>
    </Card>
  );
}

interface BarRow {
  /** Stable identity when labels can repeat (e.g. two sources sharing a
   * connector label); defaults to the label for callers with unique labels. */
  key?: string;
  label: string;
  count: number;
}

interface BarSection {
  key: string;
  /** Omitted for a flat list; rendered as a section heading otherwise. */
  label?: string;
  rows: BarRow[];
}

interface BarListCardBaseProps {
  title: string;
  description?: string;
  /** When set, each row becomes a link to this href (e.g. the explorer scoped to the row's tag). */
  getRowHref?: (row: BarRow) => string;
  /** Custom label cell (e.g. the app's Tag chip); defaults to plain text. */
  renderLabel?: (row: BarRow) => React.ReactNode;
  /** Optional action rendered on the right of the card header (e.g. an "All tags" link). */
  headerAction?: React.ReactNode;
}

/**
 * Exactly one of `rows` / `sections` — the `never` arms make that a compile
 * error rather than a documented convention, so neither "passed both" (which
 * would silently ignore `rows`) nor "passed neither" (an always-empty card)
 * can reach the runtime fallback.
 *
 * `rows` is a flat list; `sections` is a grouped one whose bars scale against
 * the max across *all* sections, so a long bar means the same thing wherever
 * it appears.
 */
type BarListCardProps = BarListCardBaseProps &
  ({ rows: BarRow[]; sections?: never } | { sections: BarSection[]; rows?: never });

function BarListCard({
  title,
  description,
  getRowHref,
  renderLabel,
  headerAction,
  ...listProps
}: BarListCardProps) {
  const resolvedSections: BarSection[] = listProps.sections ?? [{ key: 'all', rows: listProps.rows }];
  const allRows = resolvedSections.flatMap((section) => section.rows);
  const total = allRows.reduce((sum, row) => sum + row.count, 0);
  const max = allRows.reduce((best, row) => Math.max(best, row.count), 0);

  return (
    <Card>
      <Card.Header className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <Card.Title className="text-base">{title}</Card.Title>
          {description && <Card.Description>{description}</Card.Description>}
        </div>
        {headerAction}
      </Card.Header>
      <Card.Content>
        {allRows.length === 0 && <p className="py-2 text-sm text-muted-foreground">No data yet.</p>}

        <div className="flex flex-col gap-5">
          {resolvedSections.map((section) => (
            <div key={section.key} className="flex flex-col">
              {section.label && (
                <h3 className="px-2 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {section.label}
                </h3>
              )}
              {section.rows.map((row) => {
                const share = total > 0 ? (row.count / total) * 100 : 0;
                // Keep a sliver visible for tiny values so every row reads as present.
                const width = max > 0 ? Math.max((row.count / max) * 100, 0.75) : 0;
                const href = getRowHref?.(row);

                const rowContent = (
                  <>
                    {renderLabel ? (
                      <span className="flex min-w-0 justify-start">{renderLabel(row)}</span>
                    ) : (
                      <span
                        className={`truncate text-sm${href ? ' group-hover:underline underline-offset-4' : ''}`}
                      >
                        {row.label}
                      </span>
                    )}
                    <div className="h-2.5 rounded-[4px] bg-muted">
                      <div
                        className="h-full rounded-r-[4px]"
                        style={{ width: `${width}%`, backgroundColor: BAR_COLOR }}
                      />
                    </div>
                    <span className="min-w-14 text-right text-xs tabular-nums text-muted-foreground">
                      {formatCount(row.count)}
                    </span>
                  </>
                );

                const rowTitle = `${row.label}: ${formatCount(row.count)} (${share < 1 ? '<1' : Math.round(share)}% of total)`;
                const rowClass =
                  'grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50';
                const rowKey = `${section.key}-${row.key ?? row.label}`;

                return href ? (
                  <Link key={rowKey} to={href} title={rowTitle} className={`group ${rowClass}`}>
                    {rowContent}
                  </Link>
                ) : (
                  <div key={rowKey} title={rowTitle} className={rowClass}>
                    {rowContent}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Card.Content>
    </Card>
  );
}
