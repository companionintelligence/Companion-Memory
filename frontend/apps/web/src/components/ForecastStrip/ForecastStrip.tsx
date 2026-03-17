import { cn, Tooltip } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import type { ForecastBucket, ProbabilityEntry } from '@/api/useForecastService';

// ── Constants ─────────────────────────────────────────────────────────────────

const N_BUCKETS = 48;

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

/** Compute a locale-formatted time string from a bucket index (0=00:00, 47=23:30).
 *  Uses a local-timezone Date so the display is always clock-time, never UTC-offset. */
function formatBucketTime(bucketIndex: number): string {
  const mins = bucketIndex * 30;

  // Date constructor normalises overflow: bucket 48 → Jan 2 midnight → "12:00 AM"
  return new Date(2000, 0, 1, Math.floor(mins / 60), mins % 60).toLocaleTimeString([], {
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

function SlotTooltip({ bucket }: { bucket: ForecastBucket }) {
  const sorted = [...bucket.l0Probs].sort((a, b) => b.probability - a.probability);
  const top1 = topL1(bucket.l1Probs);

  return (
    <div className="w-52 space-y-2 text-left">
      <p className="text-xs font-semibold">
        {formatBucketTime(bucket.bucketIndex)} – {formatBucketTime(bucket.bucketIndex + 1)}
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
          <Link
            to={`/insights?context=${encodeURIComponent(top1.name)}`}
            className="underline underline-offset-2 hover:opacity-100 transition-opacity"
          >
            {top1.name.slice(0, 24)}
          </Link>{' '}
          ({Math.round(top1.prob * 100)}%)
        </p>
      )}
    </div>
  );
}

// ── Single 30-min slot ────────────────────────────────────────────────────────

function ForecastSlot({
  bucket,
  isFirst,
  isLast,
}: {
  bucket: ForecastBucket;
  isFirst: boolean;
  isLast: boolean;
}) {
  const dominant = dominantL0(bucket.l0Probs);
  const color = L0_BG[dominant] ?? 'bg-gray-400';
  const isEmpty = bucket.l0Probs.length === 0;
  // Empty slots (no historical data) render as faint gray; active slots clamped to [0.2, 1]
  const opacity = isEmpty ? 0.08 : Math.max(0.2, Math.min(1, bucket.q50));

  return (
    <Tooltip>
      <Tooltip.Trigger asChild>
        <div
          className={cn(
            'flex-1 h-8 cursor-default transition-transform duration-100',
            'hover:scale-y-[1.3] hover:z-10 relative',
            color,
            isFirst && 'rounded-l-full',
            isLast && 'rounded-r-full',
          )}
          style={{ opacity }}
        />
      </Tooltip.Trigger>
      <Tooltip.Content side="top" sideOffset={6} className="max-w-none p-3">
        <SlotTooltip bucket={bucket} />
      </Tooltip.Content>
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
  className?: string;
}

export function ForecastStrip({ buckets, generatedAt, className }: ForecastStripProps) {
  const pinned = normalizeBuckets(buckets);

  return (
    <div className={cn('space-y-2', className)}>
      {/* Strip — always 48 slots, 00:00 left → 23:30 right */}
      <div className="flex items-stretch gap-px" role="img" aria-label="24-hour behavioural forecast strip">
        {pinned.map((bucket, idx) => (
          <ForecastSlot
            key={bucket.bucketIndex}
            bucket={bucket}
            isFirst={idx === 0}
            isLast={idx === N_BUCKETS - 1}
          />
        ))}
      </div>

      {/* Time labels — always midnight to 23:30 */}
      <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
        <span>{formatBucketTime(0)}</span>
        <span>
          Generated {new Date(generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </span>
        <span>{formatBucketTime(N_BUCKETS - 1)}</span>
      </div>

      <Legend />
    </div>
  );
}
