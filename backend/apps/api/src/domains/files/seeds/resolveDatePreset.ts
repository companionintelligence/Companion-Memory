/**
 * Rolling When presets stored on a saved search. Must stay in lockstep with
 * `frontend/apps/web/src/pages/MemoryPage/Components/ExplorerToolbar/datePresets.ts`
 * — the explorer resolves these in the browser; shared search resolves them here
 * so a capability link still applies the owner's rolling window.
 */

export const ROLLING_DATE_PRESETS = ['yesterday', 'last-week', 'last-month', 'one-year-ago'] as const;

export type RollingDatePreset = (typeof ROLLING_DATE_PRESETS)[number];

export function isRollingDatePreset(value: string | null | undefined): value is RollingDatePreset {
  return Boolean(value && (ROLLING_DATE_PRESETS as readonly string[]).includes(value));
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/** Inclusive local-day ISO bounds, recomputed on each use. */
export function resolveDatePreset(
  preset: RollingDatePreset,
  now = new Date(),
): { startTime: string; endTime: string } {
  const todayStart = startOfLocalDay(now);

  if (preset === 'yesterday') {
    const day = new Date(todayStart);
    day.setDate(day.getDate() - 1);

    return {
      startTime: startOfLocalDay(day).toISOString(),
      endTime: endOfLocalDay(day).toISOString(),
    };
  }

  if (preset === 'last-week') {
    const from = new Date(todayStart);
    from.setDate(from.getDate() - 6);

    return {
      startTime: startOfLocalDay(from).toISOString(),
      endTime: endOfLocalDay(now).toISOString(),
    };
  }

  if (preset === 'one-year-ago') {
    const day = new Date(todayStart);
    day.setFullYear(day.getFullYear() - 1);

    return {
      startTime: startOfLocalDay(day).toISOString(),
      endTime: endOfLocalDay(day).toISOString(),
    };
  }

  const from = new Date(todayStart);
  from.setDate(from.getDate() - 29);

  return {
    startTime: startOfLocalDay(from).toISOString(),
    endTime: endOfLocalDay(now).toISOString(),
  };
}

export function resolveSavedSearchDateRange(
  filters: { datePreset?: string; startTime?: string; endTime?: string } | null | undefined,
  now = new Date(),
): { startTime?: string; endTime?: string } {
  if (filters == null) {
    return {};
  }

  if (isRollingDatePreset(filters.datePreset)) {
    return resolveDatePreset(filters.datePreset, now);
  }

  return {
    startTime: filters.startTime,
    endTime: filters.endTime,
  };
}
