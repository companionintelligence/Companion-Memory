import { useMemo } from 'react';

import { Card, cn } from '@ci/shadcn';

import type { ForecastBucket } from '@/api/useForecastService';
import { l0Background } from '@/components/ForecastStrip/ForecastStrip';
import { normalizeClass } from '@/lib/activityPalette';
import { placeVisible } from '@/lib/forecastDisplay';

import { COMMIT_MASS, branchPick, formatSlotClock, pickOpenSlot, rankSaccades } from './forageModel';
import {
  HEATMAP_COLUMNS,
  MINUTES_PER_SLOT,
  buildHeatmapRows,
  formatClock,
  formatRowLabel,
  tallyDivergence,
  type HeatmapCell,
} from './heatmapModel';

type MetricForecast = {
  metric: string;
  status: string;
  points: Array<{ date: string; q10: number; q50: number; q90: number }>;
};

type HistoryDay = {
  date: string;
  buckets: Array<{
    bucketIndex: number;
    predictedL0: Array<{ label: string; probability: number }>;
    actualL0?: string | null;
  }>;
};

type PlaceItem = {
  lat: number;
  lng: number;
  visits: number;
  share: number;
  label?: string | null;
  probability?: number;
  backoffLevel?: string | null;
};

type Calibration = {
  basis: string;
  latest: {
    l0Top1Acc: number | null;
    ece: number | null;
    driftFlag: boolean;
    modelVersion?: string | null;
  } | null;
};

function topLabel(
  entries: Array<{ label: string; probability: number }>,
): { label: string; probability: number } | null {
  const top = [...entries].sort((a, b) => b.probability - a.probability)[0];

  return top ?? null;
}

function baselineProbability(historyDays: HistoryDay[], bucketIndex: number, label: string): number | null {
  const samples = historyDays.flatMap((day) => {
    const bucket = day.buckets.find((item) => item.bucketIndex === bucketIndex);
    if (!bucket) {
      return [];
    }

    return [bucket.predictedL0.find((entry) => entry.label === label)?.probability ?? 0];
  });

  if (samples.length < 2) {
    return null;
  }

  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

export function OccupancyHonestyPanel() {
  return (
    <Card data-testid="occupancy-honesty">
      <Card.Header>
        <Card.Title>One winner per quarter-hour</Card.Title>
        <Card.Description>
          Each 15-minute bucket keeps one L0 + one L1. Anchor events beat ambient media; duration only breaks
          ties inside a tier.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          A 30-second dentist visit outranks fourteen minutes of Spotify. Losers stay in the L0 occupancy mix
          on the winning token so evening Listening can still colour the strip.
        </p>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Counted</dt>
            <dd>The salient L0 + L1 in each 15-minute bucket</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Not counted</dt>
            <dd>Ambient names on the week forecast; song titles as life labels</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Day kernel</dt>
            <dd>Recency × weekday × month × coverage — weights days, not labels</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Summary fill</dt>
            <dd>Gap tokens at 0.7, only where no event already sits</dd>
          </div>
        </dl>
      </Card.Content>
    </Card>
  );
}

export function BranchTexturePanel({ buckets, nowMs }: { buckets: ForecastBucket[]; nowMs?: number }) {
  const slot = useMemo(() => pickOpenSlot(buckets, nowMs ?? Date.now()), [buckets, nowMs]);
  if (!slot) {
    return null;
  }

  const pick = branchPick(slot);
  const clock = formatSlotClock(slot.startTime);

  return (
    <Card data-testid="branch-texture">
      <Card.Header>
        <Card.Title>Branches for {clock}</Card.Title>
        <Card.Description>
          The most unsettled upcoming half-hour. Slider 1 is L0 (the branch). Slider 2 is L1 under that slot
          (the permutation) — Forager&apos;s who-you-meet factor, on the labels we actually have. A pick
          commits at mass {Math.round(COMMIT_MASS * 100)}%.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            Branch · L0
            {pick.ready ? ` · committed ${pick.branch}` : ' · not ready'}
          </div>
          <div className="flex flex-col gap-1.5">
            {pick.branches.slice(0, 5).map((row) => (
              <div key={row.label} className="flex items-center gap-2 text-sm">
                <span className="w-24 shrink-0 truncate font-medium">{row.label}</span>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.round(row.mass * 100)}%`,
                      backgroundColor: l0Background(normalizeClass(row.label)),
                    }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                  {Math.round(row.mass * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
        {pick.permutations.length > 0 && (
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              Permutations · L1
              {pick.texture ? ` · ${pick.texture}` : ' · still mixed'}
            </div>
            <div className="flex flex-col gap-1.5">
              {pick.permutations.slice(0, 5).map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  <span className="tabular-nums text-muted-foreground">{Math.round(row.mass * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          {pick.ready
            ? `Branch is committed. Texture ${pick.texture ? `is ${pick.texture}` : 'has not crossed the same bar'} — more facts under this L0 would fill that slider.`
            : `Entropy is still high. Forager would keep sampling the lake instead of calling ${clock}.`}
        </p>
      </Card.Content>
    </Card>
  );
}

export function SaccadePanel({
  buckets,
  historyDays = [],
  nowMs,
}: {
  buckets: ForecastBucket[];
  historyDays?: HistoryDay[];
  nowMs?: number;
}) {
  const slot = useMemo(() => pickOpenSlot(buckets, nowMs ?? Date.now()), [buckets, nowMs]);
  const ranked = useMemo(
    () => (slot ? rankSaccades(historyDays, slot.bucketIndex, slot.l0Probs) : []),
    [historyDays, slot],
  );
  if (!slot || ranked.length === 0) {
    return null;
  }

  const clock = formatSlotClock(slot.startTime);

  return (
    <Card className="lg:col-span-2" data-testid="saccade-panel">
      <Card.Header>
        <Card.Title>What would collapse {clock}</Card.Title>
        <Card.Description>
          Discrete saccades over history days, not pixels. Ranked by how much that day&apos;s same half-hour
          disagrees with tomorrow (KL). High disagreement is high epistemic value — reading that slice would
          move the call. Matrices that never fill: duration, source type, L2.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          {ranked.map((row, index) => (
            <div key={row.date} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="w-6 shrink-0 tabular-nums text-muted-foreground">{index + 1}</span>
              <span className="w-28 shrink-0 font-medium">{formatRowLabel(row.date)}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {row.observed
                  ? `observed ${row.observed}`
                  : row.predicted
                    ? `predicted ${row.predicted}`
                    : 'no label'}
              </span>
              <span className="tabular-nums text-muted-foreground">KL {row.kl.toFixed(2)}</span>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          This ranking is a reading of the histogram we already serve. It does not yet drive which events get
          labeled, how long they count, or what the summary gap-fill writes.
        </p>
      </Card.Content>
    </Card>
  );
}

export function NextUpPanel({
  buckets,
  historyDays = [],
}: {
  buckets: ForecastBucket[];
  historyDays?: HistoryDay[];
}) {
  const now = Date.now();
  const upcoming = buckets
    .filter((bucket) => new Date(bucket.startTime).getTime() >= now)
    .slice(0, 8)
    .map((bucket) => {
      const top = topLabel(bucket.l0Probs);
      const l1 = topLabel(bucket.l1Probs);
      const baseline = top ? baselineProbability(historyDays, bucket.bucketIndex, top.label) : null;
      const deltaPp = top && baseline != null ? Math.round((top.probability - baseline) * 100) : null;

      return { bucket, top, l1, deltaPp };
    })
    .filter((row) => row.top);

  if (upcoming.length === 0) {
    return null;
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title>Next up</Card.Title>
        <Card.Description>
          Coming slots vs your usual baseline. Deltas hide until history exists.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-2">
        {upcoming.map(({ bucket, top, l1, deltaPp }) => (
          <div key={bucket.bucketIndex} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="w-16 shrink-0 text-muted-foreground">
              {new Date(bucket.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">
              {top?.label}
              {l1 && l1.probability > 0.1 ? (
                <span className="text-muted-foreground"> · {l1.label.slice(0, 28)}</span>
              ) : null}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {Math.round((top?.probability ?? 0) * 100)}%
            </span>
            {deltaPp != null && (
              <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                {deltaPp > 0 ? '+' : ''}
                {deltaPp} pp
              </span>
            )}
          </div>
        ))}
      </Card.Content>
    </Card>
  );
}

const METRIC_LABELS: Record<string, string> = {
  avg_sentiment: 'Sentiment',
  screen_minutes: 'Screen time',
  n_conversations: 'Conversations',
  km_traveled: 'Distance',
};

export function MetricBandsPanel({ metrics }: { metrics: MetricForecast[] }) {
  const visible = metrics.filter((metric) => metric.status === 'OK' && metric.points.length > 0);
  if (visible.length === 0) {
    return null;
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title>Metric forecast</Card.Title>
        <Card.Description>Next-day outlook (q10–q90 band, q50 point) from the daily store.</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-2 text-sm">
        {visible.map((metric) => {
          const next = metric.points[0];

          return (
            <div key={metric.metric} className="flex items-baseline justify-between">
              <span className="text-muted-foreground">
                {METRIC_LABELS[metric.metric] ?? metric.metric.replace(/_/g, ' ')}
              </span>
              <span className="font-medium">
                {next.q10.toFixed(1)} – {next.q90.toFixed(1)}
                <span className="text-muted-foreground"> (≈ {next.q50.toFixed(1)} next)</span>
              </span>
            </div>
          );
        })}
      </Card.Content>
    </Card>
  );
}

export function NextPlacesPanel({ places }: { places: PlaceItem[] }) {
  const visible = places.filter(placeVisible);
  if (visible.length === 0) {
    return null;
  }

  const backoff = visible[0]?.backoffLevel;

  return (
    <Card>
      <Card.Header>
        <Card.Title>Next places</Card.Title>
        <Card.Description>
          Likely next stay from your recent place transitions, given where you are and the time of day
          {backoff ? ` (${backoff.replace(/_/g, ' ').toLowerCase()})` : ''}.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-2 text-sm">
        {visible.map((place) => {
          const probability = place.probability ?? place.share;

          return (
            <div key={`${place.lat},${place.lng}`} className="flex items-baseline justify-between">
              <span className="min-w-0 flex-1 truncate font-medium">
                {place.label?.trim() || `${place.lat.toFixed(3)}, ${place.lng.toFixed(3)}`}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {Math.round(probability * 100)}%{place.visits > 0 ? ` · ${place.visits} stays` : ''}
              </span>
            </div>
          );
        })}
      </Card.Content>
    </Card>
  );
}

export function CalibrationPanel({ calibration }: { calibration: Calibration | null }) {
  if (!calibration?.latest) {
    return null;
  }

  const acc = calibration.latest.l0Top1Acc;
  const ece = calibration.latest.ece;

  return (
    <Card>
      <Card.Header>
        <Card.Title>Forecast trust</Card.Title>
        <Card.Description>
          Self-consistency against pipeline labels ({calibration.basis}), not ground-truth accuracy.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-1 text-sm">
        <div>Top-1 match: {acc == null ? '—' : `${Math.round(acc * 100)}%`}</div>
        <div>Calibration error (ECE): {ece == null ? '—' : ece.toFixed(3)}</div>
        {calibration.latest.modelVersion && calibration.latest.modelVersion !== 'hmt' && (
          <div>Served from the {calibration.latest.modelVersion} baseline (not the transformer).</div>
        )}
        {calibration.latest.driftFlag && (
          <div className="text-destructive">Self-consistency has drifted below its recent baseline.</div>
        )}
      </Card.Content>
    </Card>
  );
}

// ── Divergence heatmap ────────────────────────────────────────────────────────

/** One label per three hours; 96 tick labels collide at any card width. */
const COLUMN_LABEL_EVERY = 12;

/**
 * Cell hue comes from the shared activity palette, exactly as the strip above
 * does, so WORK is one colour across the whole page.
 */
function cellColor(label: string): string {
  return l0Background(normalizeClass(label));
}

function cellTitle(cell: HeatmapCell, rowLabel: string): string {
  const window = `${rowLabel} ${formatClock(cell.localMin)}–${formatClock(cell.localMin + MINUTES_PER_SLOT)}`;
  const probability = cell.predictedProbs.find((entry) => entry.label === cell.predictedDominant);
  const confidence = `${Math.round((probability?.probability ?? 0) * 100)}%`;

  if (cell.kind === 'predicted') {
    return `${window}: predicted ${cell.predictedDominant} (${confidence})`;
  }

  if (!cell.predictedDominant) {
    return `${window}: ${cell.actualL0} — nothing was predicted for this slot`;
  }

  return cell.divergent
    ? `${window}: predicted ${cell.predictedDominant} (${confidence}), actually ${cell.actualL0} — missed`
    : `${window}: ${cell.actualL0}, as predicted (${confidence})`;
}

function HeatmapCellView({ cell, rowLabel }: { cell: HeatmapCell | null; rowLabel: string }) {
  if (!cell) {
    return <div className="h-5 bg-muted-foreground/10" />;
  }

  return (
    <div
      // A native title rather than 300-odd Radix tooltip roots: this grid is an
      // order of magnitude denser than the strip above, and its accessible
      // reading is carried by the summary line and the grid's aria-label.
      title={cellTitle(cell, rowLabel)}
      className={cn('h-5 cursor-default', cell.divergent && 'ring-2 ring-inset ring-foreground')}
      style={{ backgroundColor: cellColor(cell.colorLabel), opacity: cell.opacity }}
      data-testid={cell.divergent ? 'heatmap-cell-divergent' : 'heatmap-cell'}
    />
  );
}

/**
 * Where the model was wrong.
 *
 * "Forecast trust" reports top-1 match and ECE — one number for how often the
 * model is right, with no way to see WHICH hours it misses. This grid puts each
 * logged day on a row of 96 fifteen-minute slots: past days render the class that actually
 * happened, ringed wherever the model's dominant class disagreed; then a seam;
 * then the day ahead at confidence opacity. A ring that keeps landing at 6pm
 * says something an aggregate ECE never can.
 *
 * Rows are the model's forecast days (HBPE logs and bins by UTC); columns are
 * the viewer's local clock — the same display-only reordering the strip above
 * applies. See heatmapModel.ts.
 */
export function DivergenceHeatmapPanel({
  historyDays = [],
  buckets = [],
  className,
}: {
  historyDays?: HistoryDay[];
  buckets?: ForecastBucket[];
  className?: string;
}) {
  const rows = useMemo(
    () =>
      buildHeatmapRows(
        historyDays.map((day) => ({
          date: day.date,
          buckets: day.buckets.map((slot) => ({
            bucketIndex: slot.bucketIndex,
            predictedL0: slot.predictedL0,
            actualL0: slot.actualL0 ?? null,
          })),
        })),
        buckets,
      ),
    [historyDays, buckets],
  );

  const { scored, missed } = useMemo(() => tallyDivergence(rows), [rows]);
  const firstAhead = rows.findIndex((row) => row.kind === 'ahead');

  // Nothing logged and nothing forecast — "Forecast trust" already says the
  // engine is cold, so an empty grid would only repeat it.
  if (rows.length === 0) {
    return null;
  }

  const summary =
    scored === 0
      ? 'No slots scored yet — rings appear once the nightly actuals backfill has run.'
      : `Missed ${missed} of ${scored} scored slots (${Math.round((missed / scored) * 100)}%).`;

  return (
    <Card className={className}>
      <Card.Header>
        <Card.Title>Where it was wrong</Card.Title>
        <Card.Description>
          Each row is a forecast day, each cell a 15-minute slot on your local clock. Past days show what
          actually happened; a ring marks a slot the model called differently.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        <div
          role="img"
          aria-label={`Prediction divergence heatmap across ${rows.length} days. ${summary}`}
          className="grid items-center gap-x-2 gap-y-1"
          style={{ gridTemplateColumns: 'auto minmax(0, 1fr)' }}
        >
          <div />
          <div
            className="grid text-[9px] text-muted-foreground"
            style={{ gridTemplateColumns: `repeat(${HEATMAP_COLUMNS}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: HEATMAP_COLUMNS }, (_, column) => (
              <span key={column} className="whitespace-nowrap">
                {column % COLUMN_LABEL_EVERY === 0 ? formatClock(column * MINUTES_PER_SLOT) : ''}
              </span>
            ))}
          </div>

          {rows.map((row, index) => (
            <div key={row.key} className="contents">
              {index === firstAhead && index > 0 && (
                <>
                  <div />
                  <div className="flex items-center gap-2 py-0.5" role="separator">
                    <span className="text-[9px] uppercase tracking-wide text-muted-foreground">observed</span>
                    <div className="flex-1 border-t border-dashed border-border" />
                    <span className="text-[9px] uppercase tracking-wide text-muted-foreground">forecast</span>
                  </div>
                </>
              )}

              <div className="whitespace-nowrap pr-1 text-right text-[10px] text-muted-foreground">
                {row.label}
              </div>
              <div
                className="grid gap-px overflow-hidden rounded-sm"
                style={{ gridTemplateColumns: `repeat(${HEATMAP_COLUMNS}, minmax(0, 1fr))` }}
              >
                {row.cells.map((cell, column) => (
                  <HeatmapCellView key={column} cell={cell} rowLabel={row.label} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="text-sm text-muted-foreground">{summary}</p>
        <p className="text-[10px] text-muted-foreground">
          Solid cells are observed. Faded cells are predictions — the fainter the cell, the less sure the
          model was.
        </p>
      </Card.Content>
    </Card>
  );
}
