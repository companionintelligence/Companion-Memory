/**
 * Identifier normalization — the single source of truth for the rule shared by
 * the importer (which pre-normalizes Person `properties.emails`/`.phones`) and
 * the server (which normalizes raw communication participants and defensively
 * re-normalizes ingested identifiers). The two MUST stay byte-identical or the
 * people-linking lookup silently misses.
 *
 * Rule:
 *   - email: trim + lowercase.
 *   - phone: last 10 digits of the digit string (drops country code, spaces,
 *     punctuation, '+', leading '1', etc.). Fewer than 10 digits → keep all
 *     digits as-is.
 *
 * Returns `null` when the input is empty/whitespace or (for phone) has no
 * digits, so callers can skip non-matchable values rather than store empties.
 */

export type IdentifierKind = 'email' | 'phone';

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }

  const normalized = raw.trim().toLowerCase();

  return normalized.length > 0 ? normalized : null;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) {
    return null;
  }

  // Last 10 digits — strips a leading country code (e.g. US '1') so the same
  // number written +1 (415) 555-0100 and 4155550100 collapse to one value.
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function normalizeIdentifier(kind: IdentifierKind, raw: string | null | undefined): string | null {
  return kind === 'email' ? normalizeEmail(raw) : normalizePhone(raw);
}
