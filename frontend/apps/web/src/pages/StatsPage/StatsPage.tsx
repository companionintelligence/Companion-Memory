import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card, Skeleton } from '@ci/shadcn';
import { AlertTriangle, RefreshCcw } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { PageContent } from '@/components/layout';
import { Tag } from '@/components/Tag';

import { groupSourcesByKind } from './sourceLabels';
import { useStatsService, type MemoryStats } from './useStatsService';

/** Single-series magnitude bars use one theme chart hue; identity comes from
 * the row label, so no legend is needed. */
const BAR_COLOR = 'var(--chart-2)';

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatDay(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function StatsPage() {
  usePageTitle('Stats - Companion Intelligence');

  const { data, loading, error, refresh } = useStatsService();

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Stats</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {error && <ErrorNotice message={error} onRetry={refresh} />}
        {!error && loading && <StatsSkeleton />}
        {!error && !loading && data && <StatsBody stats={data} />}
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

function StatsBody({ stats }: { stats: MemoryStats }) {
  const { isFeatureEnabled } = useFeatures();
  const earliest = formatDay(stats.dateRange.earliest);
  const latest = formatDay(stats.dateRange.latest);

  return (
    <div className="flex flex-col gap-6">
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
          value={earliest && latest ? `${earliest} → ${latest}` : '—'}
          detail="Earliest → latest timeline event"
        />
      </div>

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

interface StatTileProps {
  label: string;
  value: string;
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
  const resolvedSections: BarSection[] =
    listProps.sections ?? [{ key: 'all', rows: listProps.rows }];
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
