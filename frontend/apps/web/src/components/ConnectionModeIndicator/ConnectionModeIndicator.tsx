import { useCallback, useState } from 'react';

import { useConnectionMode, type ConnectionMode } from '@ci/common';
import { Button, Popover, cn } from '@ci/shadcn';
import { Monitor, Smartphone } from '@ci/shadcn/icons';
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

// The label names the state; the hint says what it means for the user. A bare
// dot is unreadable without one — nothing on screen says what a green dot is.
const HINT_KEY: Record<ConnectionMode, string> = {
  connected: 'CONNECTION_MODE_CONNECTED_HINT',
  local: 'CONNECTION_MODE_LOCAL_HINT',
  cached: 'CONNECTION_MODE_CACHED_HINT',
  fresh: 'CONNECTION_MODE_FRESH_HINT',
};

/**
 * A tiny persistent chip showing the current {@link ConnectionMode}: one
 * icon — a monitor while the appliance answers, a phone while the app is
 * answering from this phone (its sidecar, its synced copy, or nothing yet)
 * — with the mode's colour as a dot on the icon's corner. The label is for
 * screen readers and the tooltip; on screen the icon is the whole chip.
 *
 * It used to spell the mode out ("On this phone", "Not synced yet"), which
 * on a phone's top bar left the search box a quarter of the width once the
 * outbox chip and the add menu had theirs (Kyle, 2026-10-22).
 *
 * A tap opens a small popover with the mode's name, what it means, and a
 * "Check again" that re-runs the health check. It was a hover tooltip: on a
 * phone a tap focused the chip, the tooltip opened, and the same tap's click
 * closed it — a flash. The design doc's detail sheet (what is reachable,
 * last-synced time) is a future pass.
 */
export function ConnectionModeIndicator() {
  const { mode, isResolved, refresh } = useConnectionMode();
  const { t } = useTranslation();

  const label = t(LABEL_KEY[mode]);
  const hint = t(HINT_KEY[mode]);
  const Icon = mode === 'connected' ? Monitor : Smartphone;
  const [open, setOpen] = useState(false);

  const handleRefresh = useCallback(() => {
    refresh();
    setOpen(false);
  }, [refresh]);

  // Nothing to report until the first probe answers: the pre-probe mode is
  // "fresh", and rendering it would tell the user the app has never synced
  // every time a page loads, moments before the health check says otherwise.
  if (!isResolved) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative inline-flex size-7 shrink-0 cursor-pointer select-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={label}
          data-testid="connection-mode-chip"
          data-mode={mode}
        >
          <Icon className="size-4" strokeWidth={1.75} aria-hidden="true" />
          <span
            className={cn(
              'absolute right-1 top-1 inline-block size-1.5 rounded-full ring-2 ring-background',
              DOT_CLASS[mode],
            )}
            aria-hidden="true"
          />
          <span className="sr-only">{label}</span>
        </button>
      </Popover.Trigger>
      <Popover.Content align="end" className="w-64 space-y-2 text-sm" data-testid="connection-mode-popover">
        <div className="font-medium">{label}</div>
        <p className="text-muted-foreground">{hint}</p>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          {t('CONNECTION_MODE_CHECK_AGAIN')}
        </Button>
      </Popover.Content>
    </Popover>
  );
}
