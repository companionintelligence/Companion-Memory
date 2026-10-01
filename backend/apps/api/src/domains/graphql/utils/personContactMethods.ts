import { hasPhoneExtension, normalizeIdentifier, type IdentifierKind } from '@ci/domains/graph';

import type { PersonIdentifierType } from '../types/PersonIdentifierType';

type ContactKind = 'email' | 'phone';

/**
 * The `properties` keys the person form OWNS — exactly the keys
 * {@link contactMethodsFromPersonProperties} reads a contact from, so every row
 * the form shows can be removed through it. `createPerson` writes
 * `emails`/`phones`; the import push copies a contact's handle into
 * `email` + `emails` or `phone` + `phones`; a merge unions them; migration
 * 20260930020117 parks a typed extension number in `phones`.
 *
 * An import's typed record of a contact card — `Emails`, `Phones`, `Faxes`,
 * `Names` — is deliberately NOT owned. It is the source's own words, a
 * re-import rewrites it, and natural-key repairs read it back as evidence
 * (20260930020117 proves a truncated phone key from `Phones`), so the form
 * never edits it.
 */
const FORM_CONTACT_KEYS = [
  { key: 'email', isList: false },
  { key: 'emails', isList: true },
  { key: 'phone', isList: false },
  { key: 'phones', isList: true },
] as const;

/**
 * Emails and phones already stored on the person row (`properties.email` /
 * `.emails` / `.phone` / `.phones`) but never copied into
 * `ci.entity_identifiers`. The Details card only reads identifiers, so those
 * contacts used to render as "No details yet" even when we had the address
 * from the message that created them.
 *
 * A phone carrying an extension is shown AS TYPED, with the typed string as its
 * `value`. It has no join key — the shared rule refuses it, because keeping its
 * last ten digits fabricated somebody else's number — but it is still the way to
 * reach this person, and the display must not lose it along with the key.
 */
export function contactMethodsFromPersonProperties(person: {
  email?: string | null;
  properties?: Record<string, unknown> | null;
}): PersonIdentifierType[] {
  const props = person.properties ?? {};
  const out: PersonIdentifierType[] = [];
  const seen = new Set<string>();

  const push = (kind: 'email' | 'phone', raw: string, label: string | null) => {
    const normalized =
      normalizeIdentifier(kind, raw) ?? (kind === 'phone' && hasPhoneExtension(raw) ? raw.trim() : null);
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
 * The `properties` patch a person-form save needs besides the identifier
 * index, or {} when it needs none.
 *
 * The form sends its whole contact list, so a contact it showed and no longer
 * sends was removed — and the row's own copy of it has to go with the index
 * row. Left behind, `identifiers` shows it again, the next edit re-submits it,
 * and the identifier backfill re-indexes it. Only the keys the form owns are
 * edited (see `FORM_CONTACT_KEYS`), and only entries the form showed: a stored
 * value it never displayed is not the user's to have dropped.
 *
 * A value an import still carries is written back by that import's next run.
 * That is the source restating it, as it re-asserts the index row.
 */
export function droppedContactsPatch(
  person: { email?: string | null; properties?: Record<string, unknown> | null },
  submitted: ReadonlyArray<{ kind: ContactKind; value: string }>,
): Record<string, unknown> {
  const listed = new Set(submitted.map((contact) => contactMatchKey(contact.kind, contact.value)));

  return withoutContacts(person, (matchKey) => !listed.has(matchKey));
}

/** {@link droppedContactsPatch} for removing ONE contact method (`removePersonIdentifier`). */
export function removedContactPatch(
  person: { email?: string | null; properties?: Record<string, unknown> | null },
  kind: ContactKind,
  value: string,
): Record<string, unknown> {
  const removed = contactMatchKey(kind, value);

  return withoutContacts(person, (matchKey) => matchKey === removed);
}

/**
 * How a stored contact and a submitted one are compared: by join key when the
 * value has one, so "(555) 010-0142" and "555.010.0142" are the same number.
 * A value with no join key can only be recognised by what was typed, so that is
 * compared with spacing and letter case forgiven.
 */
function contactMatchKey(kind: ContactKind, value: string): string {
  const joinKey = normalizeIdentifier(kind, value);

  return joinKey != null
    ? `${kind}:${joinKey}`
    : `${kind}:typed:${value.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

/**
 * Remove from the form-owned keys every stored entry the Details card shows as
 * a contact whose match key `isRemoved` accepts. Returns the changed keys only.
 */
function withoutContacts(
  person: { email?: string | null; properties?: Record<string, unknown> | null },
  isRemoved: (matchKey: string) => boolean,
): Record<string, unknown> {
  const props = person.properties ?? {};
  const patch: Record<string, unknown> = {};

  for (const { key, isList } of FORM_CONTACT_KEYS) {
    // Egress strips `email` out of the bag and surfaces it as a named field.
    const stored: unknown = key === 'email' && props.email === undefined ? person.email : props[key];
    const entries: unknown[] = Array.isArray(stored) ? stored : stored == null ? [] : [stored];

    const kept = entries.filter((entry) => {
      // Asked of the display itself, so an edit can never disagree with what
      // the form was seeded from.
      const [row] = contactMethodsFromPersonProperties({ properties: { [key]: [entry] } });

      return row == null || !isRemoved(contactMatchKey(row.kind as ContactKind, row.rawValue ?? row.value));
    });

    if (kept.length < entries.length) {
      // A list stays a list: SQL readers hand `emails`/`phones` straight to
      // jsonb_array_elements, which rejects a JSON null. A cleared scalar is
      // null, as a blanked form field is.
      patch[key] = Array.isArray(stored) || isList ? kept : null;
    }
  }

  return patch;
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

/**
 * The unusable contact values (`unusableIdentifiers`) worth failing a person
 * edit over: every one except a row the user left untouched — one the
 * person's own record states, with the same label.
 *
 * The edit form seeds its contact list from `identifiers`, which shows a phone
 * carrying an extension as typed, and every save re-submits the whole list.
 * Refusing those would fail every later save of the person — a fix to their
 * name included — over a number nobody touched, and one this form cannot
 * remove anyway: it lives in properties, not in the index. It stays where it
 * is, shown and inert for matching.
 *
 * Anything else the user asserted is refused, a relabelled row included: the
 * label has nowhere to go either, and dropping it without a word is the
 * failure this refusal exists to end. {@link contactsToReconcile} does not
 * make this redundant: it cannot key an unusable value, because it has no
 * normalized form, so it passes those rows through.
 */
export function unusableToSurface<T extends { kind: IdentifierKind; value: string; label?: string | null }>(
  unusable: readonly T[],
  person: { email?: string | null; properties?: Record<string, unknown> | null },
): T[] {
  if (unusable.length === 0) {
    return [];
  }

  // An unusable value is displayed with the typed string as its `value`, and
  // the form sends that back trimmed, as it sends a missing label back as ''.
  const statedLabels = new Map(
    contactMethodsFromPersonProperties(person).map((row) => [`${row.kind}:${row.value}`, row.label ?? null]),
  );

  return unusable.filter((entry) => {
    const key = `${entry.kind}:${entry.value.trim()}`;

    return !statedLabels.has(key) || (entry.label?.trim() || null) !== statedLabels.get(key);
  });
}
