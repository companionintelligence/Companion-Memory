import { cn, Tooltip } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import type { ForecastBucket, ProbabilityEntry } from '@/api/useForecastService';
import { useFeatures } from '@/common/feature';

// ── Constants ─────────────────────────────────────────────────────────────────

const N_BUCKETS = 48;
const MINUTES_PER_BUCKET = 30;
const MINUTES_PER_DAY = 24 * 60;

// ── Colour mapping ────────────────────────────────────────────────────────────

const L0_BG: Record<string, string> = {
  WORK: 'bg-blue-500',
  EXERCISE: 'bg-green-500',
  SOCIAL: 'bg-orange-500',
  ERRAND: 'bg-yellow-500',
  LEISURE: 'bg-purple-500',
  TRANSIT: 'bg-teal-500',
  SLEEP: 'bg-indigo-500',
  UNKNOWN: 'bg-gray-400',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Local minutes-since-midnight for an ISO instant, or null if empty/unparseable. */
function localMinutesOfDay(iso: string): number | null {
  if (!iso) {
    return null;
  }

  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d.getHours() * 60 + d.getMinutes();
}

/** Format minutes-since-local-midnight as a clock label (e.g. 510 → "8:30 AM"). */
function formatClock(minutesOfDay: number): string {
  const m = ((minutesOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  // Date constructor normalises overflow: 1440 → Jan 2 midnight → "12:00 AM"
  return new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Always returns exactly N_BUCKETS entries sorted 0–47, filling gaps with neutral defaults. */
function normalizeBuckets(raw: ForecastBucket[]): ForecastBucket[] {
  const byIndex = new Map(raw.map((b) => [b.bucketIndex, b]));

  return Array.from(
    { length: N_BUCKETS },
    (_, i) =>
      byIndex.get(i) ?? {
        bucketIndex: i,
        startTime: '',
        l0Probs: [],
        l1Probs: [],
        l2Probs: null,
        q10: 0,
        q50: 0,
        q90: 0,
      },
  );
}

/**
 * Order the 48 buckets so the strip reads local midnight → 23:30, labeling each by its
 * real instant in the viewer's local time.
 *
 * HBPE bins behaviour by UTC time-of-day, so bucket N describes the UTC half-hour N — but
 * each bucket carries its real `startTime` instant. We derive the viewer's UTC→local
 * offset from the first bucket with a valid instant, apply it to every bucket (so gap-
 * filled buckets sort correctly too), then order into a local day. Timezone handling stays
 * purely at display: no server-side re-bucketing, and it tracks the browser clock (incl.
 * DST) automatically. With no valid instants (non-READY placeholder), offset is 0 and the
 * strip falls back to index order (00:00 → 23:30).
 */
function orderLocalDay(raw: ForecastBucket[]): { bucket: ForecastBucket; localMin: number }[] {
  const pinned = normalizeBuckets(raw);

  let offsetMin = 0;
  for (const bucket of pinned) {
    const lm = localMinutesOfDay(bucket.startTime);
    if (lm != null) {
      offsetMin =
        (((lm - bucket.bucketIndex * MINUTES_PER_BUCKET) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
        MINUTES_PER_DAY;
      break;
    }
  }

  return pinned
    .map((bucket) => ({
      bucket,
      localMin: (bucket.bucketIndex * MINUTES_PER_BUCKET + offsetMin) % MINUTES_PER_DAY,
    }))
    .sort((a, b) => a.localMin - b.localMin);
}

function dominantL0(probs: ProbabilityEntry[]): string {
  return probs.reduce(
    (best, { label, probability }) => (probability > best.probability ? { label, probability } : best),
    { label: 'UNKNOWN', probability: -1 },
  ).label;
}

function topL1(probs: ProbabilityEntry[]): { name: string; prob: number } | null {
  if (!probs.length) {
    return null;
  }

  const top = probs.reduce((best, cur) => (cur.probability > best.probability ? cur : best));

  return { name: top.label, prob: top.probability };
}

// ── Tooltip content ───────────────────────────────────────────────────────────

function SlotTooltip({ bucket, localMin }: { bucket: ForecastBucket; localMin: number }) {
  const { isFeatureEnabled } = useFeatures();
  const sorted = [...bucket.l0Probs].sort((a, b) => b.probability - a.probability);
  const top1 = topL1(bucket.l1Probs);

  return (
    <div className="w-52 space-y-2 text-left">
      <p className="text-xs font-semibold">
        {formatClock(localMin)} – {formatClock(localMin + MINUTES_PER_BUCKET)}
      </p>

      <div className="space-y-1">
        {sorted.map(({ label, probability }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-right text-[10px] opacity-75">{label}</span>
            <div className="flex-1 h-1.5 rounded-full bg-current/20 overflow-hidden">
              <div
                className={cn('h-full rounded-full', L0_BG[label] ?? 'bg-gray-400')}
                style={{ width: `${Math.round(probability * 100)}%` }}
              />
            </div>
            <span className="w-7 shrink-0 text-[10px] opacity-75 tabular-nums">
              {Math.round(probability * 100)}%
            </span>
          </div>
        ))}
      </div>

      {top1 && top1.prob > 0.1 && (
        <p className="pt-1 border-t border-current/20 text-[10px] opacity-60">
          Top context:{' '}
          {isFeatureEnabled('insights.page') ? (
            <Link
              to={`/insights?context=${encodeURIComponent(top1.name)}`}
              className="underline underline-offset-2 hover:opacity-100 transition-opacity"
            >
              {top1.name.slice(0, 24)}
            </Link>
          ) : (
            <span>{top1.name.slice(0, 24)}</span>
          )}{' '}
          ({Math.round(top1.prob * 100)}%)
        </p>
      )}
    </div>
  );
}

// ── Single 30-min slot ────────────────────────────────────────────────────────

function ForecastSlot({
  bucket,
  localMin,
  isFirst,
  isLast,
  systemStatus,
}: {
  bucket: ForecastBucket;
  localMin: number;
  isFirst: boolean;
  isLast: boolean;
  systemStatus: string;
}) {
  const isReady = systemStatus === 'READY';
  const dominant = dominantL0(bucket.l0Probs);

  // Standard styling for READY state
  const color = isReady ? (L0_BG[dominant] ?? 'bg-gray-400') : 'bg-primary/60';
  const isEmpty = bucket.l0Probs.length === 0;
  const targetOpacity = isEmpty ? 0.08 : Math.max(0.2, Math.min(1, bucket.q50));

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>
        <div
          className={cn(
            'flex-1 h-8 cursor-default transition-all duration-100',
            isReady && 'hover:scale-y-[1.3] hover:z-10 relative',
            color,
            isFirst && 'rounded-l-full',
            isLast && 'rounded-r-full',
          )}
          style={{
            opacity: isReady ? targetOpacity : undefined,
          }}
        />
      </Tooltip.Trigger>
      {isReady && (
        <Tooltip.Content side="top" sideOffset={6} className="max-w-none p-3">
          <SlotTooltip bucket={bucket} localMin={localMin} />
        </Tooltip.Content>
      )}
    </Tooltip>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

const LEGEND_CLASSES = ['WORK', 'EXERCISE', 'SOCIAL', 'ERRAND', 'LEISURE', 'TRANSIT', 'SLEEP'] as const;

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {LEGEND_CLASSES.map((cls) => (
        <div key={cls} className="flex items-center gap-1">
          <div className={cn('w-2 h-2 rounded-sm', L0_BG[cls])} />
          <span className="text-[10px] text-muted-foreground">{cls}</span>
        </div>
      ))}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

interface ForecastStripProps {
  buckets: ForecastBucket[];
  generatedAt: string;
  systemStatus?: string;
  /** True when polling gave up because the engine stayed non-READY too long. */
  stalled?: boolean;
  className?: string;
}

const STATUS_LABELS: Record<string, string> = {
  COLD_START: 'Waiting to initialize...',
  'BOOTSTRAP:queued': 'Getting ready to initialize...',
  'BOOTSTRAP:label': 'Labeling your events and content...',
  'BOOTSTRAP:label_summaries': 'Labeling your recent activity...',
  'BOOTSTRAP:serialize': 'Preparing training data...',
  'BOOTSTRAP:train': 'Training your prediction model...',
  'BOOTSTRAP:export': 'Optimizing model for your device...',
  'BOOTSTRAP:lora': 'Fine-tuning your personalized adapter...',
  'NIGHTLY:queued': 'Updating your predictions...',
  'NIGHTLY:label': 'Labeling new events...',
  'NIGHTLY:label_summaries': 'Labeling recent activity...',
  'NIGHTLY:l1_sweep': 'Updating behavioral patterns...',
  'NIGHTLY:l2_sweep': 'Updating behavioral patterns...',
  'NIGHTLY:lora': 'Fine-tuning your model...',
  'NIGHTLY:drift': 'Checking for behavior changes...',
  'NIGHTLY:cache': 'Refreshing predictions...',
};

export function ForecastStrip({
  buckets,
  generatedAt,
  systemStatus = 'READY',
  stalled = false,
  className,
}: ForecastStripProps) {
  const ordered = orderLocalDay(buckets);

  const isReady = systemStatus === 'READY';
  const statusLabel = isReady
    ? `Generated ${new Date(generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : stalled
      ? 'Prediction model not built yet — open Add ▸ Predict to start'
      : (STATUS_LABELS[systemStatus] ?? 'Processing...');

  return (
    <div className={cn('space-y-2', className)}>
      {/* Strip — always 48 slots, 00:00 left → 23:30 right */}
      <div className="flex items-stretch gap-px" role="img" aria-label="24-hour behavioral forecast strip">
        {ordered.map(({ bucket, localMin }, idx) => (
          <ForecastSlot
            key={bucket.bucketIndex}
            bucket={bucket}
            localMin={localMin}
            isFirst={idx === 0}
            isLast={idx === N_BUCKETS - 1}
            systemStatus={systemStatus}
          />
        ))}
      </div>

      {/* Time labels — local midnight to 23:30 */}
      <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
        <span>{formatClock(ordered[0]?.localMin ?? 0)}</span>
        <span
          className={
            !isReady && !stalled ? 'animate-pulse text-primary' : !isReady ? 'text-muted-foreground' : ''
          }
        >
          {statusLabel}
        </span>
        <span>
          {formatClock(ordered[ordered.length - 1]?.localMin ?? MINUTES_PER_DAY - MINUTES_PER_BUCKET)}
        </span>
      </div>

      {isReady && <Legend />}
    </div>
  );
}
