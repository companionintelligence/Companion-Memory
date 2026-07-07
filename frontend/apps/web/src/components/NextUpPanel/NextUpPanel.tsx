import { useMemo } from 'react';

import { cn } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import type { ForecastBucket } from '@/api/useForecastService';
import { useFeatures } from '@/common/feature';

import { formatClock, L0_BG } from '../ForecastStrip/forecastData';

import { deriveNextUp, type NextUpSegment } from './deriveNextUp';

function titleCase(l0: string): string {
  return l0.charAt(0) + l0.slice(1).toLowerCase();
}

function clockOf(date: Date): string {
  return formatClock(date.getHours() * 60 + date.getMinutes());
}

function SegmentChip({ segment }: { segment: NextUpSegment }) {
  const { isFeatureEnabled } = useFeatures();
  const context = segment.topContext;
  const contextLabel = context ? context.name.slice(0, 28) : null;

  return (
    <li className="flex min-w-40 flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2">
      <span className="text-[10px] text-muted-foreground tabular-nums">
        {clockOf(segment.start)} – {clockOf(segment.end)}
      </span>

      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <span className={cn('h-2 w-2 shrink-0 rounded-sm', L0_BG[segment.l0] ?? 'bg-gray-400')} />
        {titleCase(segment.l0)}
        <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
          {Math.round(segment.meanProb * 100)}%
        </span>
      </span>

      {contextLabel && (
        <span className="truncate text-[10px] text-muted-foreground">
          {isFeatureEnabled('insights.page') && context ? (
            <Link
              to={`/insights?context=${encodeURIComponent(context.name)}`}
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              {contextLabel}
            </Link>
          ) : (
            contextLabel
          )}
        </span>
      )}
    </li>
  );
}

interface NextUpPanelProps {
  buckets: ForecastBucket[];
  systemStatus?: string;
  className?: string;
}

/**
 * Glanceable companion to the ForecastStrip: the forecast window distilled into a
 * short chronological list of predicted activity segments ("what's ahead"), each
 * with its dominant class, mean probability, and strongest L1 context.
 *
 * Renders nothing until the engine is READY and at least one meaningful segment
 * exists — the strip already narrates cold-start/bootstrap states, so this panel
 * never duplicates that messaging.
 */
export function NextUpPanel({ buckets, systemStatus = 'READY', className }: NextUpPanelProps) {
  const { segments, mode } = useMemo(
    () => (systemStatus === 'READY' ? deriveNextUp(buckets) : { segments: [], mode: 'today' as const }),
    [buckets, systemStatus],
  );

  if (segments.length === 0) {
    return null;
  }

  return (
    <div className={cn('space-y-2', className)}>
      <h3 className="text-sm font-semibold text-foreground">
        {mode === 'today' ? 'Next up' : 'Tomorrow at a glance'}
      </h3>
      <ul className="flex flex-wrap gap-2" aria-label="Predicted upcoming activities">
        {segments.map((segment) => (
          <SegmentChip key={segment.start.toISOString()} segment={segment} />
        ))}
      </ul>
    </div>
  );
}
