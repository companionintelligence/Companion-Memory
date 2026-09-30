import { normalizeIdentifier } from '@ci/domains/graph';

import type { PersonIdentifierType } from '../types/PersonIdentifierType';

/**
 * Emails and phones already stored on the person row (`properties.email` /
 * `.emails` / `.phone` / `.phones`) but never copied into
 * `ci.entity_identifiers`. The Details card only reads identifiers, so those
 * contacts used to render as "No details yet" even when we had the address
 * from the message that created them.
 */
export function contactMethodsFromPersonProperties(person: {
  email?: string | null;
  properties?: Record<string, unknown> | null;
}): PersonIdentifierType[] {
  const props = person.properties ?? {};
  const out: PersonIdentifierType[] = [];
  const seen = new Set<string>();

  const push = (kind: 'email' | 'phone', raw: string, label: string | null) => {
    const normalized = normalizeIdentifier(kind, raw);
    if (normalized == null) {
      return;
    }

    const key = `${kind}:${normalized}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    out.push({
      kind,
      value: normalized,
      rawValue: raw.trim(),
      label,
      isPrimary: false,
      source: 'properties',
      verifiedAt: null,
    });
  };

  for (const entry of readContactEntries(person.email)) {
    push('email', entry.value, entry.label);
  }

  for (const entry of readContactEntries(props.email)) {
    push('email', entry.value, entry.label);
  }

  for (const entry of readContactEntries(props.emails)) {
    push('email', entry.value, entry.label);
  }

  for (const entry of readContactEntries(props.phone)) {
    push('phone', entry.value, entry.label);
  }

  for (const entry of readContactEntries(props.phones)) {
    push('phone', entry.value, entry.label);
  }

  return out;
}

/**
 * Index rows win when the same mailbox is stored both ways; property-only
 * contacts fill the gaps the Details card used to leave blank.
 */
export function mergePersonIdentifiers(
  fromIndex: PersonIdentifierType[],
  fromProperties: PersonIdentifierType[],
): PersonIdentifierType[] {
  const seen = new Set(fromIndex.map((row) => `${row.kind}:${row.value}`));
  const extras = fromProperties.filter((row) => !seen.has(`${row.kind}:${row.value}`));

  return [...fromIndex, ...extras];
}

/**
 * The contact rows of an edit-form save that `replaceForEntity` may reconcile.
 *
 * The form seeds its list from `identifiers` — this person's index rows AND the
 * property-only contacts {@link contactMethodsFromPersonProperties} adds — and
 * every save re-submits the whole list. A property-only row the user did not
 * touch is not something they asserted, and reconciling it does one of two
 * wrong things:
 *
 *  - Nobody holds it, so it is INDEXED, as `source = 'user'` and verified.
 *    Migration 20260930022046 writes a value another card lists under a
 *    different name (an office line, the owner's work address on a friend's
 *    card) into `properties` and deliberately NOT into the index. The first
 *    save of a colleague's form would resolve every call from that office to
 *    them, in a row that looks user-entered and so outlives any import cleanup.
 *  - Another person holds it (first writer wins), so it CONFLICTS, and
 *    `updatePerson` refuses the whole save — a typo fix in the name included —
 *    until someone merges the two.
 *
 * So an untouched property-only row stays where it was: on the record, off the
 * index. A row already indexed for this person is reconciled as before (its
 * label, the primary flag, its removal), and a row the user typed — or one
 * whose label they changed — is theirs to assert, conflict and all.
 */
export function contactsToReconcile<
  T extends { kind: 'email' | 'phone'; value: string; label?: string | null },
>(
  submitted: readonly T[],
  person: {
    /** This person's own `ci.entity_identifiers` rows. */
    indexed: ReadonlyArray<{ kind: string; valueNormalized: string }>;
    /** What the record states: {@link contactMethodsFromPersonProperties}. */
    stated: readonly PersonIdentifierType[];
  },
): T[] {
  const indexed = new Set(person.indexed.map((row) => `${row.kind}:${row.valueNormalized}`));
  const statedLabels = new Map(person.stated.map((row) => [`${row.kind}:${row.value}`, row.label ?? null]));

  return submitted.filter((contact) => {
    const valueNormalized = normalizeIdentifier(contact.kind, contact.value);

    // Unusable, and `replaceForEntity` skips it itself.
    if (valueNormalized == null) {
      return true;
    }

    const key = `${contact.kind}:${valueNormalized}`;

    if (indexed.has(key) || !statedLabels.has(key)) {
      return true;
    }

    // Property-only: kept only when the user relabelled it. The form sends a
    // missing label back as ''.
    return (contact.label?.trim() || null) !== statedLabels.get(key);
  });
}

function readContactEntries(value: unknown): Array<{ value: string; label: string | null }> {
  if (typeof value === 'string') {
    const trimmed = value.trim();

    return trimmed.length > 0 ? [{ value: trimmed, label: null }] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  const entries: Array<{ value: string; label: string | null }> = [];

  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        entries.push({ value: trimmed, label: null });
      }

      continue;
    }

    if (item == null || typeof item !== 'object') {
      continue;
    }

    const record = item as Record<string, unknown>;
    const raw = record.value ?? record.email ?? record.address ?? record.phone;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      continue;
    }

    const label =
      typeof record.label === 'string'
        ? record.label.trim()
        : typeof record.type === 'string'
          ? record.type.trim()
          : '';

    entries.push({ value: raw.trim(), label: label.length > 0 ? label : null });
  }

  return entries;
}
