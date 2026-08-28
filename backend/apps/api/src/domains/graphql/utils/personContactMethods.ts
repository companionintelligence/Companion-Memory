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
