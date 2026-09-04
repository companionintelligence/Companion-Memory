import { Button, Card, Skeleton, cn } from '@ci/shadcn';
import { AlertTriangle, CheckCircle2, Info, RefreshCcw } from '@ci/shadcn/icons';
import { useState } from 'react';

import { cardPad, usePhone } from './Fold';
import { categoryChartColor, categoryLabel } from './jobCategories';
import { jobVerdicts, type JobVerdict, type VerdictTone } from './jobVerdicts';
import type { JobFilters } from './useJobsList';

type Props = {
  stateCounts: Readonly<Record<string, number>>;
  categoryCounts: Readonly<Record<string, number>>;
  crons: ReadonlyArray<{
    name: string;
    overdue?: boolean;
    lastRunAt?: string | null;
    lastSuccessAt?: string | null;
  }>;
  loading: boolean;
  onSelect: (filter: Partial<JobFilters>) => void;
  onOpenSchedules: () => void;
  /**
   * Clear terminal jobs for a Health verdict. Returns when the server has
   * deleted them so the card can refresh. Null/absent when the caller cannot
   * clear (e.g. preview without the route).
   */
  onClearTerminal?: (scope: 'dead-letter' | 'failed') => Promise<void>;
  /** Live queue counts — the same six the page used to print in its own card. */
  summary: JobsSummary | undefined;
  refreshing: boolean;
  error: string | null;
  staleSince: Date | null;
  updatedAt: Date | null;
  onRefresh: () => void;
  onSelectState: (state: string) => void;
};

/** The six states, as `GET /jobs/dashboard` reports them. */
export type JobsSummary = {
  readonly pending: number;
  readonly active: number;
  readonly retry: number;
  readonly completed: number;
  readonly failed: number;
  readonly deadLettered: number;
};

/**
 * The six queue states, in the order work moves through them. `key` reads the
 * dashboard summary; `state` is what the jobs table filters on.
 */
const STATE_TILES: ReadonlyArray<{ label: string; key: keyof JobsSummary; state: string }> = [
  { label: 'Pending', key: 'pending', state: 'created' },
  { label: 'Running', key: 'active', state: 'active' },
  { label: 'Retrying', key: 'retry', state: 'retry' },
  { label: 'Completed', key: 'completed', state: 'completed' },
  { label: 'Failed', key: 'failed', state: 'failed' },
  { label: 'Dead-lettered', key: 'deadLettered', state: 'dead-letter' },
];

/**
 * What is wrong right now, in sentences.
 *
 * Replaces the six summary tiles. Those were accurate and mute: "Dead-lettered
 * 8,431" sat at the same weight as "Retrying 2", and on the appliance this was
 * built against the first number was 43% of every job on the box. The reader had
 * to notice that, divide, and go looking. This card does the noticing.
 *
 * The counts have not gone away — they are the second half of the card, as one
 * proportional bar rather than six equal boxes, because "where is the work" is a
 * question about SHARE and six same-sized tiles are the one shape that cannot
 * show share.
 */
export function JobHealthCard({
  stateCounts,
  categoryCounts,
  crons,
  loading,
  onSelect,
  onOpenSchedules,
  onClearTerminal,
  summary,
  refreshing,
  error,
  staleSince,
  updatedAt,
  onRefresh,
  onSelectState,
}: Props) {
  const phone = usePhone();
  const verdicts = jobVerdicts({ stateCounts, categoryCounts, crons });

  const total = Object.values(stateCounts).reduce((sum, n) => sum + n, 0);

  // The bar's denominator is the CATEGORY total, not the state total.
  //
  // They are different sets. `stateCounts` honours the category and type
  // filters; `categoryCounts` deliberately ignores them so each chip can show
  // what picking it would yield. Dividing an unfiltered slice by a filtered
  // total made the segments overflow their track the moment any category was
  // selected — on `/jobs?category=llm` the total was 262 while the ingest slice
  // alone was 5,977, i.e. a segment 22x the width of the bar.
  const categoryTotal = Object.values(categoryCounts).reduce((sum, n) => sum + n, 0);
  const slices = Object.entries(categoryCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const shown = slices.slice(0, 5);
  const rest = slices.slice(5).reduce((sum, [, count]) => sum + count, 0);
  const emptyCategories = Object.values(categoryCounts).filter((count) => count === 0).length;

  return (
    <Card>
      <Card.Header
        className={cn(
          'flex gap-2',
          phone
            ? 'flex-row items-center justify-between'
            : 'flex-col md:flex-row md:items-center md:justify-between',
          cardPad(phone),
        )}
      >
        <div className="min-w-0">
          <Card.Title className="text-base">Health</Card.Title>
          <Card.Description>
            {updatedAt
              ? `What the job system is doing, and whether any of it needs you — as of ${new Intl.DateTimeFormat(
                  undefined,
                  { hour: '2-digit', minute: '2-digit', second: '2-digit' },
                ).format(updatedAt)}`
              : 'What the job system is doing, and whether any of it needs you.'}
          </Card.Description>
        </div>
        {/* Spins in place. The figures below stay exactly where they are — a
            refresh that blanked the card is what sent an operator to a page
            with nothing on it every time they asked it a question. */}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          aria-busy={refreshing || undefined}
          className={phone ? 'shrink-0' : 'w-full md:w-auto'}
        >
          <RefreshCcw className={cn(phone ? 'h-4 w-4' : 'mr-2 h-4 w-4', refreshing && 'animate-spin')} />
          {phone ? (
            <span className="sr-only">{refreshing ? 'Refreshing' : 'Refresh'}</span>
          ) : refreshing ? (
            'Refreshing'
          ) : (
            'Refresh'
          )}
        </Button>
      </Card.Header>

      <Card.Content className={cn('space-y-4', cardPad(phone))}>
        {staleSince ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
          >
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">
              Showing data from {staleSince.toLocaleTimeString()} — refreshes have been failing since then
              {error ? ` (${error})` : ''}.
            </span>
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : null}

        {loading && total === 0 ? (
          <Skeleton className="h-24 w-full" />
        ) : verdicts.length === 0 ? (
          // Deliberately not "all healthy": nothing has been read yet, and a
          // page that reassures before it knows has lied once.
          <p className="text-sm text-muted-foreground">
            No job history yet on this appliance — nothing has been queued.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {verdicts.map((verdict) => (
              <VerdictRow
                key={verdict.id}
                verdict={verdict}
                onSelect={onSelect}
                onOpenSchedules={onOpenSchedules}
                onClearTerminal={onClearTerminal}
              />
            ))}
          </ul>
        )}

        {/* The six live counts, under the verdicts rather than in a card of
            their own. They were six equal boxes above this one, which put
            "Dead-lettered 8,535" at exactly the weight of "Retrying 0" and
            repeated, in tiles, the two figures the sentences above had already
            called out. Kept because they are the working set an operator
            filters by, and each is still a shortcut into the table — a number
            you cannot click is one you have to go hunting for. */}
        {loading && !summary ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="flex flex-wrap gap-x-1 gap-y-1.5 border-t border-border/60 pt-3">
            {STATE_TILES.map((tile) => {
              const value = summary?.[tile.key] ?? 0;

              return (
                <button
                  key={tile.state}
                  type="button"
                  onClick={() => onSelectState(tile.state)}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted/60',
                    // Zero is not worth the ink of a live count: it stays
                    // readable and clickable, it just stops competing.
                    value === 0 && 'text-muted-foreground',
                  )}
                >
                  <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                    {tile.label}
                  </span>
                  <span className="mt-0.5 block text-base font-semibold tabular-nums">
                    {value.toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {slices.length > 0 && categoryTotal > 0 ? (
          <div>
            <div className="flex h-[7px] overflow-hidden rounded-full bg-muted" role="presentation">
              {shown.map(([category, count]) => (
                <span
                  key={category}
                  className="h-full"
                  style={{
                    width: `${(count / categoryTotal) * 100}%`,
                    background: categoryChartColor(category),
                  }}
                />
              ))}
              {rest > 0 ? (
                <span
                  className="h-full bg-muted-foreground/50"
                  style={{ width: `${(rest / categoryTotal) * 100}%` }}
                />
              ) : null}
            </div>

            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {shown.map(([category, count]) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => onSelect({ category, type: '', offset: 0 })}
                  className="inline-flex items-center gap-1.5 rounded hover:text-foreground"
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-sm"
                    style={{ background: categoryChartColor(category) }}
                  />
                  {categoryLabel(category)}
                  <span className="tabular-nums">{count.toLocaleString()}</span>
                </button>
              ))}
              {rest > 0 ? <span className="tabular-nums">Other {rest.toLocaleString()}</span> : null}
              {emptyCategories > 0 ? (
                <span className="text-muted-foreground/70">
                  · {emptyCategories} {emptyCategories === 1 ? 'category' : 'categories'} empty
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </Card.Content>
    </Card>
  );
}

const TONE: Record<VerdictTone, { wrap: string; icon: typeof AlertTriangle; iconClass: string }> = {
  critical: {
    wrap: 'border-destructive/30 bg-destructive/10',
    icon: AlertTriangle,
    iconClass: 'text-destructive',
  },
  warning: { wrap: 'border-amber-500/30 bg-amber-500/10', icon: Info, iconClass: 'text-amber-500' },
  ok: { wrap: 'border-emerald-500/25 bg-emerald-500/10', icon: CheckCircle2, iconClass: 'text-emerald-500' },
};

/**
 * One verdict.
 *
 * Show sits at the end of the copy as a text action — it runs the filter the
 * sentence was computed from, so a wrong number is visible the moment you open
 * the table. Clear (when offered) is a real button on the right: it deletes the
 * terminal rows the sentence named, after a confirm.
 */
function VerdictRow({
  verdict,
  onSelect,
  onOpenSchedules,
  onClearTerminal,
}: {
  verdict: JobVerdict;
  onSelect: (filter: Partial<JobFilters>) => void;
  onOpenSchedules: () => void;
  onClearTerminal?: (scope: 'dead-letter' | 'failed') => Promise<void>;
}) {
  const tone = TONE[verdict.tone];
  const Icon = tone.icon;
  const canShow = verdict.filter != null || verdict.action === 'View schedules';
  const canClear = verdict.clearScope != null && onClearTerminal != null;
  const [clearing, setClearing] = useState(false);

  const onShow = () => {
    if (verdict.filter) {
      onSelect(verdict.filter);
      return;
    }

    onOpenSchedules();
  };

  const onClear = async () => {
    if (!verdict.clearScope || !onClearTerminal || clearing) {
      return;
    }

    const label =
      verdict.clearScope === 'dead-letter'
        ? 'Permanently delete every dead-lettered job on this appliance?'
        : 'Permanently delete every failed job on this appliance?';

    if (!window.confirm(label)) {
      return;
    }

    setClearing(true);

    try {
      await onClearTerminal(verdict.clearScope);
    } finally {
      setClearing(false);
    }
  };

  return (
    <li className={cn('flex items-start gap-3 rounded-lg border p-3', tone.wrap)}>
      <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0', tone.iconClass)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug">{verdict.headline}</p>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
          {verdict.detail ? <span>{verdict.detail} </span> : null}
          {canShow ? (
            <button
              type="button"
              onClick={onShow}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {verdict.action ?? 'Show'}
            </button>
          ) : null}
        </p>
      </div>
      {canClear ? (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 self-center text-xs"
          disabled={clearing}
          aria-busy={clearing || undefined}
          onClick={() => void onClear()}
        >
          {clearing ? 'Clearing…' : 'Clear'}
        </Button>
      ) : null}
    </li>
  );
}
