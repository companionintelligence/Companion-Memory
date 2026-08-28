/**
 * Money on the physical-things surface is stored as an INTEGER number of MINOR
 * units alongside an ISO-4217 code (`totalMinor: 1299`, `currency: 'USD'` reads
 * as $12.99) — see the `Integer MINOR units of \`currency\`` doc-strings on
 * ReceiptType and ReceiptLineItemType.
 *
 * The minor-unit exponent is NOT always 2. JPY and KRW have none, and a
 * hardcoded `/100` would render ¥1299 as ¥12.99 — off by two orders of
 * magnitude on every yen receipt. The divisor therefore comes from Intl's own
 * resolved options for the currency rather than from a constant.
 */

/** Fallback when a row carries an amount but no currency code. */
const DEFAULT_CURRENCY = 'USD';

/** Formatted money, or null when there is no amount to show. */
export function formatMinor(minor?: number | null, currency?: string | null): string | null {
  if (minor == null || !Number.isFinite(minor)) {
    return null;
  }

  const code = (currency ?? DEFAULT_CURRENCY).trim().toUpperCase() || DEFAULT_CURRENCY;

  let formatter: Intl.NumberFormat;

  try {
    formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
  } catch {
    // An unknown/garbage code must not blank the whole receipt: fall back to a
    // plain two-decimal amount with the code spelled out beside it.
    return `${(minor / 100).toFixed(2)} ${code}`;
  }

  const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;

  return formatter.format(minor / 10 ** exponent);
}

/**
 * Formatted money for an amount already in MAJOR units, or null when there is
 * nothing to show.
 *
 * `ItemType.purchasePrice` and `ItemType.currentValue` are `Float` majors — a
 * different representation from the receipt plane's integer minors, and the
 * reason this is a second function rather than a flag on `formatMinor`. Both
 * share the currency handling, which is the part that was being hardcoded to a
 * dollar sign at the call sites.
 */
export function formatAmount(amount?: number | null, currency?: string | null): string | null {
  if (amount == null || !Number.isFinite(amount)) {
    return null;
  }

  const code = (currency ?? DEFAULT_CURRENCY).trim().toUpperCase() || DEFAULT_CURRENCY;

  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(amount);
  } catch {
    // Same rule as formatMinor: an unknown code must not blank the row.
    return `${amount} ${code}`;
  }
}
