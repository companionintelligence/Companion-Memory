import { cn, Tooltip } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import type { ForecastBucket } from '@/api/useForecastService';
import { useFeatures } from '@/common/feature';

import {
  dominantL0,
  formatClock,
  L0_BG,
  MINUTES_PER_BUCKET,
  MINUTES_PER_DAY,
  N_BUCKETS,
  orderLocalDay,
  topL1,
} from './forecastData';

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
