/**
 * Shared identifier normalization for backend domains that need stable email,
 * phone, and display-name keys. Keep this in common so consumers do not reach
 * across domain internals or load the graph module just to normalize a value.
 *
 * The email and phone rules must stay byte-identical for import, graph linking,
 * and memory writes. The phone extension pattern is also embedded in migrations
 * and pinned by the graph normalization spec.
 */

export type IdentifierKind = 'email' | 'phone' | 'name';

/**
 * A phone value that carries an extension or a dial-string suffix: `;` `,` `#`,
 * `x` / `ext` / `extn` / `extension` (a `.` and `:` allowed) before a digit —
 * not at the end only ("x229 (office)"), and not only after a space
 * ("2125550147x229") — or Android's pause/wait `p` / `w` between digits.
 *
 * Such a value is not one number, and its digits cannot be keyed: the join key
 * is the last ten digits of the digit string, so "(310) 447-8675;229" keyed as
 * 4478675229 — the office's area code gone, the extension appended, and what
 * is left a well-formed number that belongs to somebody else. The main line
 * alone is no better: everybody at that office shares it.
 *
 * One pattern for every reader. No lookbehind, so the same string works as a
 * JS `RegExp(…, 'i')` and under Postgres `~*`: migrations
 * `20260930022046_index_contact_card_emails_and_phones` and
 * `20260930020117_refuse_phone_extension_join_keys` embed it verbatim, and
 * `normalizeIdentifier.spec.ts` pins both.
 */
export const PHONE_EXTENSION_PATTERN = String.raw`[;,#]|(?:^|[^a-z])(?:ext(?:ension|n)?|x)\.?\s*:?\s*\d|\d\s*[pw]\s*\d`;

const PHONE_EXTENSION = new RegExp(PHONE_EXTENSION_PATTERN, 'i');

/** True when a phone value carries an extension ({@link PHONE_EXTENSION_PATTERN}). */
export function hasPhoneExtension(raw: string | null | undefined): boolean {
  return raw != null && PHONE_EXTENSION.test(raw);
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }

  // Many sources hand us the full RFC 5322 mailbox ("Display Name <addr@x>",
  // or "<addr@x>") rather than a bare address. Extract the angle-bracketed
  // address first — otherwise the display name is folded into the identifier
  // and the same mailbox fragments across many Person entities.
  const angle = raw.match(/<([^>]+)>/);
  const candidate = angle ? angle[1] : raw;

  const normalized = candidate.trim().toLowerCase();

  return normalized.length > 0 ? normalized : null;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }

  // Refused rather than truncated or stripped — see hasPhoneExtension. The
  // duplicate detector's `parsePhone` and `toE164` refuse the same values, so
  // this is the join key catching up with the two parsers that already knew.
  if (hasPhoneExtension(raw)) {
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

/**
 * Display-name identifier for participants that carry neither an email nor a
 * phone number (chat networks — Facebook Messenger, Instagram — export display
 * names only). NFKD-fold + strip diacritics, lowercase, collapse whitespace,
 * so "José  GARCÍA" and "jose garcia" collapse to one value. Weaker than an
 * email/phone (display names are not globally unique), which is acceptable for
 * the per-user identifier index: the tuple is scoped to owner_user_id, and a
 * chat participant's display name is stable within one user's corpus.
 */
export function normalizeName(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }

  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length > 0 ? normalized : null;
}

export function normalizeIdentifier(kind: IdentifierKind, raw: string | null | undefined): string | null {
  if (kind === 'email') {
    return normalizeEmail(raw);
  }

  if (kind === 'phone') {
    return normalizePhone(raw);
  }

  return normalizeName(raw);
}
