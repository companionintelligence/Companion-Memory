/** Rolling date presets for the Memory explorer When filter. */
export type DatePreset = 'yesterday' | 'last-week' | 'last-month' | 'one-year-ago';

export type DatePresetSelection = DatePreset | 'custom';

export const DATE_PRESET_OPTIONS: ReadonlyArray<{ value: DatePresetSelection; label: string }> = [
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last-week', label: 'Last week' },
  { value: 'last-month', label: 'Last month' },
  { value: 'one-year-ago', label: 'One year ago' },
  { value: 'custom', label: 'Custom' },
];

/** 2×2 preset picker layout: Yesterday + Custom on top, week/month below. */
export const WHEN_PRESET_GRID: ReadonlyArray<{ value: DatePresetSelection; label: string }> = [
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'custom', label: 'Custom' },
  { value: 'last-week', label: 'Last week' },
  { value: 'last-month', label: 'Last month' },
];

const ROLLING_PRESETS = new Set<string>(['yesterday', 'last-week', 'last-month', 'one-year-ago']);

export function isRollingDatePreset(value: string | null | undefined): value is DatePreset {
  return Boolean(value && ROLLING_PRESETS.has(value));
}

export function datePresetLabel(value: string | null | undefined): string | null {
  if (!value || value === 'custom') {
    return null;
  }

  return DATE_PRESET_OPTIONS.find((option) => option.value === value)?.label ?? null;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/** Resolve a rolling preset to inclusive local-day ISO bounds (recomputed on each use). */
export function resolveDatePreset(preset: DatePreset, now = new Date()): { from: string; to: string } {
  const todayStart = startOfLocalDay(now);

  if (preset === 'yesterday') {
    const day = new Date(todayStart);
    day.setDate(day.getDate() - 1);

    return {
      from: startOfLocalDay(day).toISOString(),
      to: endOfLocalDay(day).toISOString(),
    };
  }

  if (preset === 'last-week') {
    const from = new Date(todayStart);
    from.setDate(from.getDate() - 6);

    return {
      from: startOfLocalDay(from).toISOString(),
      to: endOfLocalDay(now).toISOString(),
    };
  }

  if (preset === 'one-year-ago') {
    const day = new Date(todayStart);
    day.setFullYear(day.getFullYear() - 1);

    return {
      from: startOfLocalDay(day).toISOString(),
      to: endOfLocalDay(day).toISOString(),
    };
  }

  const from = new Date(todayStart);
  from.setDate(from.getDate() - 29);

  return {
    from: startOfLocalDay(from).toISOString(),
    to: endOfLocalDay(now).toISOString(),
  };
}

/** True when `from`/`to` match a rolling preset's bounds for `now` (within 1s). */
export function inferRollingDatePreset(
  from: string | null | undefined,
  to: string | null | undefined,
  now = new Date(),
): DatePreset | null {
  if (!from && !to) {
    return null;
  }

  for (const preset of ROLLING_PRESETS) {
    const resolved = resolveDatePreset(preset as DatePreset, now);

    if (resolved.from === from && resolved.to === to) {
      return preset as DatePreset;
    }
  }

  return null;
}
