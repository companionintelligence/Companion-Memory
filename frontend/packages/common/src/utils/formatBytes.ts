/** How {@link formatBytes} writes a byte count; the defaults are "512 B", "100.0 KB", "2.4 GB". */
export interface FormatBytesOptions {
  /** 1024 (binary, the default) or 1000. */
  base?: 1000 | 1024;
  /** The unit labels from bytes up. The count never goes past the last one. */
  units?: readonly string[];
  /** Fraction digits, or a function of the unit's index. Default: none for bytes, one above. */
  decimals?: number | ((unitIndex: number) => number);
  /** Drop a fraction that is all zeros ("1 KiB", not "1.00 KiB"). */
  trimZeros?: boolean;
  /** The smallest unit shown, as an index into `units`: a count below it is written in it. */
  minUnit?: number;
}

export const BINARY_UNITS: readonly string[] = ['B', 'KB', 'MB', 'GB', 'TB'];
export const DECIMAL_UNITS: readonly string[] = ['B', 'kB', 'MB', 'GB', 'TB'];
export const IEC_UNITS: readonly string[] = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];

const ONE_DECIMAL_ABOVE_BYTES = (unitIndex: number): number => (unitIndex === 0 ? 0 : 1);

/**
 * A byte count as people read it. Every surface used to carry its own copy
 * with its own units and rounding; the options say which this one is.
 */
export function formatBytes(bytes: number, options: FormatBytesOptions = {}): string {
  const {
    base = 1024,
    units = BINARY_UNITS,
    decimals = ONE_DECIMAL_ABOVE_BYTES,
    trimZeros = false,
    minUnit = 0,
  } = options;
  let value = bytes;
  let unit = 0;

  while ((unit < minUnit || value >= base) && unit < units.length - 1) {
    value /= base;
    unit += 1;
  }

  const places = Math.max(0, typeof decimals === 'function' ? decimals(unit) : decimals);
  const fixed = value.toFixed(places);

  return `${trimZeros ? String(parseFloat(fixed)) : fixed} ${units[unit]}`;
}
