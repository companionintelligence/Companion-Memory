/**
 * Pure derivation for the forecast divergence heatmap — one row per HBPE
 * forecast day, 96 fifteen-minute columns, kept free of React so it runs in the fast
 * `node` vitest project.
 *
 * The point of the grid is the *misses*. `predictionCalibration` already tells
 * you the model is x% accurate; nothing on this page tells you WHERE it was
 * wrong. Every past cell here carries both the observed class and the class the
 * model had predicted for that slot, so a disagreement can be marked.
 *
 * ── Time basis ───────────────────────────────────────────────────────────────
 * HBPE bins behaviour by UTC time-of-day: `hbpe.prediction_log.horizon_start` is
 * a UTC midnight and `bucket_index` is the 15-minute slot after it
 * (histogram_api.build_histogram → InferenceEngine.predict). `forecastHistory`
 * therefore hands us a UTC `date` plus a bucket index and NO instant, while the
 * live `forecast` hands us a real `startTime`.
 *
 * We reconstruct the instant from `date + bucketIndex` when it is missing, then
 * place every cell by its LOCAL clock — the same display-only UTC→local
 * reordering `ForecastStrip.orderLocalDay` already does one panel above, so the
 * two surfaces read on the same axis. A row is still labelled by its UTC
 * forecast day; with a non-zero offset the row is that day's 24 hours shifted
 * into the viewer's local day, exactly as the strip renders it.
 */

import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

export const HEATMAP_COLUMNS = 96;
export const MINUTES_PER_SLOT = 15;

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Cells dimmer than this stop reading as a colour at all. */
const MIN_OPACITY = 0.2;

export interface ProbabilityEntryLike {
  label: string;
  probability: number;
}

/** One bucket of `forecastHistory` — predicted distribution + backfilled actual. */
export interface HistoryBucketLike {
  bucketIndex: number;
  predictedL0: ProbabilityEntryLike[];
  actualL0: string | null;
}

/** One day of `forecastHistory`: a UTC calendar date and its logged buckets. */
export interface HistoryDayLike {
  date: string;
  buckets: HistoryBucketLike[];
}

/** One bucket of the live `forecast` query. */
export interface ForecastBucketLike {
  bucketIndex: number;
  startTime: string;
  l0Probs: ProbabilityEntryLike[];
}

export interface HeatmapCell {
  /** Local 15-minute column, 0 (midnight) … 95 (23:45). */
  column: number;
  /** Minutes since local midnight for the slot start. */
  localMin: number;
  /** The L0 class that colours the cell. */
  colorLabel: string;
  /** 0..1 — full for observed actuals, confidence-scaled for predictions. */
  opacity: number;
  /** 'actual' = what happened; 'predicted' = what the model expected. */
  kind: 'actual' | 'predicted';
  /** Dominant predicted class for the slot, when a prediction was logged. */
  predictedDominant: string | null;
  /** Full predicted distribution, for the tooltip. */
  predictedProbs: ProbabilityEntryLike[];
  /** Observed class, once the nightly actuals backfill has run. */
  actualL0: string | null;
  /** True when the observed class disagrees with the predicted dominant one. */
  divergent: boolean;
}

export type HeatmapCells = (HeatmapCell | null)[];

export interface HeatmapRow {
  /** Stable key — the UTC forecast date, YYYY-MM-DD. */
  key: string;
  label: string;
  /** 'past' rows can show actuals; 'ahead' rows are prediction-only. */
  kind: 'past' | 'ahead';
  cells: HeatmapCells;
}

/** Highest-probability entry, or null for an empty distribution. */
export function dominantEntry(probs: ProbabilityEntryLike[]): ProbabilityEntryLike | null {
  if (!probs.length) {
    return null;
  }

  return probs.reduce((best, cur) => (cur.probability > best.probability ? cur : best));
}

/**
 * The real instant a logged bucket describes: UTC midnight of `dateKey` plus
 * `bucketIndex` fifteen-minute slots. Null when either input is out of range.
 *
 * This is the field the abandoned spike keyed off directly — `startTime` is not
 * on `ForecastHistoryBucketType`, and deriving it needs no resolver change
 * because `bucket_index` is unambiguous (see the module docstring).
 */
export function bucketInstant(dateKey: string, bucketIndex: number): Date | null {
  const match = DATE_KEY_PATTERN.exec(dateKey ?? '');
  if (!match) {
    return null;
  }

  if (!Number.isInteger(bucketIndex) || bucketIndex < 0 || bucketIndex >= HEATMAP_COLUMNS) {
    return null;
  }

  const [, year, month, day] = match;
  const utcMidnight = Date.UTC(Number(year), Number(month) - 1, Number(day));

  return new Date(utcMidnight + bucketIndex * MINUTES_PER_SLOT * MS_PER_MINUTE);
}

/** Minutes since local midnight for an instant, or null when unparseable. */
export function localMinutesOfDay(instant: Date | string | null): number | null {
  if (instant == null) {
    return null;
  }

  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d.getHours() * 60 + d.getMinutes();
}

/** Local 15-minute column (0..95) for an instant, or null when unparseable. */
export function localColumn(instant: Date | string | null): number | null {
  const minutes = localMinutesOfDay(instant);

  return minutes == null ? null : Math.floor(minutes / MINUTES_PER_SLOT);
}

/** UTC calendar-date key (YYYY-MM-DD) for an instant, or null when unparseable. */
export function utcDateKey(instant: Date | string): string | null {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d.toISOString().slice(0, 10);
}

/**
 * Format minutes-since-local-midnight as a clock label (510 → "8:30 AM", or "08:30" in 24-hour).
 * A column position, not an instant, so only the hour cycle applies.
 */
export function formatClock(minutesOfDay: number, fmt: DateTimeFormatter): string {
  const m = ((minutesOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  return fmt.clock(Math.floor(m / 60), m % 60);
}

/** Row label like "Mon 7/14" from a YYYY-MM-DD key, or the key when malformed. */
export function formatRowLabel(dateKey: string): string {
  const match = DATE_KEY_PATTERN.exec(dateKey ?? '');
  if (!match) {
    return dateKey;
  }

  const [, year, month, day] = match;
  const weekday = new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString('en-US', {
    weekday: 'short',
  });

  return `${weekday} ${Number(month)}/${Number(day)}`;
}

function clampOpacity(probability: number): number {
  if (!Number.isFinite(probability)) {
    return MIN_OPACITY;
  }

  return Math.max(MIN_OPACITY, Math.min(1, probability));
}

/**
 * Divergence compares the RAW class tokens, not the palette's normalised class.
 * `normalizeClass` folds anything it does not recognise into UNKNOWN, which
 * would silently turn a real miss between two unrecognised labels into a match —
 * and hiding misses is the one thing this panel must not do.
 */
function diverges(predictedDominant: string | null, actual: string): boolean {
  if (!predictedDominant) {
    return false;
  }

  return predictedDominant.trim().toUpperCase() !== actual.trim().toUpperCase();
}

/**
 * Cells for one logged past day. An observed slot renders the ACTUAL class at
 * full opacity and is flagged when the model's dominant class disagreed; a slot
 * whose actual has not been backfilled yet falls back to the prediction at
 * confidence opacity, so a not-yet-scored day is visibly softer than a scored one.
 */
export function buildHistoryCells(day: HistoryDayLike): HeatmapCells {
  const cells: HeatmapCells = Array.from({ length: HEATMAP_COLUMNS }, () => null);

  for (const bucket of day.buckets ?? []) {
    const column = localColumn(bucketInstant(day.date, bucket.bucketIndex));
    // A DST shift inside one UTC day can land two buckets in one column; the
    // earlier bucket keeps the slot so the row stays deterministic.
    if (column == null || cells[column]) {
      continue;
    }

    const dominant = dominantEntry(bucket.predictedL0 ?? []);

    if (bucket.actualL0) {
      cells[column] = {
        column,
        localMin: column * MINUTES_PER_SLOT,
        colorLabel: bucket.actualL0,
        opacity: 1,
        kind: 'actual',
        predictedDominant: dominant?.label ?? null,
        predictedProbs: bucket.predictedL0 ?? [],
        actualL0: bucket.actualL0,
        divergent: diverges(dominant?.label ?? null, bucket.actualL0),
      };
      continue;
    }

    if (dominant) {
      cells[column] = {
        column,
        localMin: column * MINUTES_PER_SLOT,
        colorLabel: dominant.label,
        opacity: clampOpacity(dominant.probability),
        kind: 'predicted',
        predictedDominant: dominant.label,
        predictedProbs: bucket.predictedL0 ?? [],
        actualL0: null,
        divergent: false,
      };
    }
  }

  return cells;
}

/**
 * The single row ahead: the live 24h histogram, which HBPE always issues for the
 * next UTC day (`horizon_start = tomorrow 00:00Z`). Returns null when no bucket
 * carries a usable instant and distribution — a non-READY engine has nothing to
 * draw, and an empty row would read as "predicted nothing".
 */
export function buildForecastRow(buckets: ForecastBucketLike[]): HeatmapRow | null {
  const cells: HeatmapCells = Array.from({ length: HEATMAP_COLUMNS }, () => null);
  let dateKey: string | null = null;

  for (const bucket of buckets ?? []) {
    const instant = new Date(bucket.startTime);
    if (Number.isNaN(instant.getTime())) {
      continue;
    }

    const column = localColumn(instant);
    const dominant = dominantEntry(bucket.l0Probs ?? []);
    if (column == null || !dominant || cells[column]) {
      continue;
    }

    // The row's UTC forecast day = the horizon start, i.e. this bucket's instant
    // walked back by its own index. Every bucket agrees, so the first wins.
    dateKey ??= utcDateKey(
      new Date(instant.getTime() - bucket.bucketIndex * MINUTES_PER_SLOT * MS_PER_MINUTE),
    );

    cells[column] = {
      column,
      localMin: column * MINUTES_PER_SLOT,
      colorLabel: dominant.label,
      opacity: clampOpacity(dominant.probability),
      kind: 'predicted',
      predictedDominant: dominant.label,
      predictedProbs: bucket.l0Probs ?? [],
      actualL0: null,
      divergent: false,
    };
  }

  if (!dateKey) {
    return null;
  }

  return { key: dateKey, label: formatRowLabel(dateKey), kind: 'ahead', cells };
}

/**
 * Full grid: the logged past days oldest-first, then the day ahead. The panel
 * draws its seam between the last 'past' row and the first 'ahead' one.
 */
export function buildHeatmapRows(
  historyDays: HistoryDayLike[],
  forecastBuckets: ForecastBucketLike[],
): HeatmapRow[] {
  const past: HeatmapRow[] = (historyDays ?? [])
    .filter((day) => DATE_KEY_PATTERN.test(day?.date ?? ''))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      key: day.date,
      label: formatRowLabel(day.date),
      kind: 'past' as const,
      cells: buildHistoryCells(day),
    }));

  const ahead = buildForecastRow(forecastBuckets ?? []);

  // A re-issued forecast for a day already in the log would otherwise draw twice.
  return ahead && !past.some((row) => row.key === ahead.key) ? [...past, ahead] : past;
}

export interface DivergenceTally {
  /** 15-minute slots with a backfilled actual. */
  scored: number;
  /** Of those, how many the model got wrong. */
  missed: number;
}

/** How often the model missed across the whole grid — the panel's headline. */
export function tallyDivergence(rows: HeatmapRow[]): DivergenceTally {
  let scored = 0;
  let missed = 0;

  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell?.kind !== 'actual' || !cell.predictedDominant) {
        continue;
      }

      scored += 1;
      if (cell.divergent) {
        missed += 1;
      }
    }
  }

  return { scored, missed };
}
