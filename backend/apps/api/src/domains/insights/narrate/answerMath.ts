import type { Aggregate, ValueFormat } from './questionCatalog';

/** One day's value + coverage for the metric a question reads. */
export interface DaySample {
  date: string;
  value: number;
  coverage: number;
}

export interface AggregateResult {
  /** null when there were no days with data in the window. */
  value: number | null;
  daysWithData: number;
  meanCoverage: number;
}

/**
 * Collapse a metric's daily series over a timeframe. `samples` must already be
 * filtered to days that HAVE a value (a null metric day is dropped upstream), so
 * an empty series means "no data", which yields a null value — never a fake 0.
 */
export function aggregate(mode: Aggregate, samples: DaySample[]): AggregateResult {
  if (samples.length === 0) {
    return { value: null, daysWithData: 0, meanCoverage: 0 };
  }

  const meanCoverage = samples.reduce((acc, s) => acc + s.coverage, 0) / samples.length;

  let value: number;
  switch (mode) {
    case 'latest': {
      const latest = samples.reduce((a, b) => (a.date >= b.date ? a : b));
      value = latest.value;
      break;
    }

    case 'sum':
      value = samples.reduce((acc, s) => acc + s.value, 0);
      break;
    case 'avg':
      value = samples.reduce((acc, s) => acc + s.value, 0) / samples.length;
      break;
    case 'max':
      value = samples.reduce((max, s) => Math.max(max, s.value), Number.NEGATIVE_INFINITY);
      break;
    case 'active_days':
      value = samples.filter((s) => s.value > 0).length;
      break;
  }

  return { value, daysWithData: samples.length, meanCoverage };
}

/** Optional unit conversion applied before display formatting. */
export function applyScale(value: number, scale?: number): number {
  return scale === undefined ? value : value * scale;
}

/** Format a numeric value for narration according to a question's format. */
export function formatValue(value: number, format: ValueFormat): string {
  switch (format) {
    case 'int':
      return String(Math.round(value));
    case 'float1':
      return value.toFixed(1);
    case 'float2':
      return value.toFixed(2);
    case 'money':
      return value.toFixed(2);
    case 'signed2':
      return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
  }
}
