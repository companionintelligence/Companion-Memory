import { Button, Card, Skeleton, cn } from '@ci/shadcn';
import { AlertTriangle, CheckCircle2, Info } from '@ci/shadcn/icons';

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
};

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
      <Card.Header className={cardPad(phone)}>
        <Card.Title className="text-base">Health</Card.Title>
        <Card.Description>What the job system is doing, and whether any of it needs you.</Card.Description>
      </Card.Header>

      <Card.Content className={cn('space-y-4', cardPad(phone))}>
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
              />
            ))}
          </ul>
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
 * The action is not decoration: it runs the filter the sentence was computed
 * from. That is what keeps the claim and the evidence from drifting — a verdict
 * whose number disagrees with the table it opens is visibly wrong, immediately,
 * rather than quietly wrong forever.
 */
function VerdictRow({
  verdict,
  onSelect,
  onOpenSchedules,
}: {
  verdict: JobVerdict;
  onSelect: (filter: Partial<JobFilters>) => void;
  onOpenSchedules: () => void;
}) {
  const tone = TONE[verdict.tone];
  const Icon = tone.icon;
  const actionable = verdict.filter != null || verdict.action === 'View schedules';

  return (
    <li className={cn('flex items-start gap-3 rounded-lg border p-3', tone.wrap)}>
      <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0', tone.iconClass)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug">{verdict.headline}</p>
        {verdict.detail ? (
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{verdict.detail}</p>
        ) : null}
      </div>
      {actionable ? (
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 self-center text-xs"
          onClick={() => (verdict.filter ? onSelect(verdict.filter) : onOpenSchedules())}
        >
          {verdict.action ?? 'Show'}
        </Button>
      ) : null}
    </li>
  );
}
