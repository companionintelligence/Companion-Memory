import { useCallback } from 'react';

import { useConnectionMode, type ConnectionMode } from '@ci/common';
import { Badge, cn } from '@ci/shadcn';
import { useTranslation } from 'react-i18next';

// Dot color per mode. Kept local rather than pulled from the design system's
// semantic palette — this is the only place that needs a fixed red/amber/…
// mapping to a functional state rather than to intent (destructive, warning…).
const DOT_CLASS: Record<ConnectionMode, string> = {
  connected: 'bg-emerald-500',
  local: 'bg-sky-500',
  cached: 'bg-amber-500',
  fresh: 'bg-muted-foreground',
};

const LABEL_KEY: Record<ConnectionMode, string> = {
  connected: 'CONNECTION_MODE_CONNECTED',
  local: 'CONNECTION_MODE_LOCAL',
  cached: 'CONNECTION_MODE_CACHED',
  fresh: 'CONNECTION_MODE_FRESH',
};

/**
 * Small persistent chip showing the current {@link ConnectionMode}: a solid
 * dot plus a short label ("On this phone", "Offline copy", "Not synced yet"),
 * except "Connected" which — per the design doc — is kept to just the dot,
 * with the label present only for screen readers.
 *
 * Tapping it is a no-op for this pass; the design doc calls for a detail
 * sheet (breakdown of what's reachable, last-synced time, manual refresh)
 * in a future pass.
 */
export function ConnectionModeIndicator() {
  const { mode, refresh } = useConnectionMode();
  const { t } = useTranslation();

  const label = t(LABEL_KEY[mode]);

  const handleClick = useCallback(() => {
    // TODO: open the connection-mode detail sheet (future pass). For now,
    // tapping just re-runs the raced health check.
    console.log(`[ConnectionModeIndicator] tapped, mode=${mode}`);
    refresh();
  }, [mode, refresh]);

  return (
    <Badge
      variant="outline"
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className="cursor-pointer select-none gap-1.5"
      aria-label={label}
    >
      <span
        className={cn('inline-block size-1.5 shrink-0 rounded-full', DOT_CLASS[mode])}
        aria-hidden="true"
      />
      <span className={mode === 'connected' ? 'sr-only' : undefined}>{label}</span>
    </Badge>
  );
}
