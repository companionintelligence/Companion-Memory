import { labelForSource, titleCaseSourceKey } from '@/lib/sourceNames';

import type { EntitySourceKind, SourceCount } from './useStatsService';

/**
 * Display names for provenance keys CI-Server writes about *itself* — things
 * that are not connectors and so have no place in the shared connector map.
 * Anything not listed falls through to {@link labelForSource}, which knows the
 * connectors and title-cases whatever it does not recognise. Neither layer is a
 * whitelist: `properties.Source` and `sourceSystem` are unvalidated free text,
 * so an unknown value must still render.
 */
const PROVENANCE_LABELS: Readonly<Record<string, string>> = {
  self: 'Your own profile',
  Unknown: 'No recorded source',
  files: 'Photos and files',
  users: 'Your account',
  'import:self': 'Your own profile',
  'import:graph_llm': 'Extracted concepts',
  'import:communications:participant': 'Message participants',
};

/** Section order on the page: where things came from, then what we made of it. */
export const SOURCE_KIND_ORDER: readonly EntitySourceKind[] = ['imported', 'derived', 'self', 'unknown'];

const SOURCE_KIND_LABELS: Readonly<Record<EntitySourceKind, string>> = {
  imported: 'Imported from elsewhere',
  derived: 'Worked out on this device',
  self: 'You',
  unknown: 'Unattributed',
};

export function sourceKindLabel(kind: EntitySourceKind): string {
  return SOURCE_KIND_LABELS[kind] ?? kind;
}

/**
 * Label a resolved provenance key. The `import:` prefix is a storage
 * convention, so it is stripped before the connector lookup — that is what
 * turns `import:apple_contacts` into "Contacts" rather than "Apple Contacts".
 */
export function sourceLabel(source: string): string {
  const override = PROVENANCE_LABELS[source];

  if (override) {
    return override;
  }

  return labelForSource(source.replace(/^import:/, ''));
}

export interface SourceGroup {
  kind: EntitySourceKind;
  label: string;
  /** `key` is the raw source — unique within a group, unlike the label. */
  rows: Array<{ key: string; label: string; count: number }>;
}

/**
 * Anything the API sends that this build does not know about is shown as
 * unattributed rather than dropped — a stats page that silently omits rows is
 * worse than one that admits it cannot classify them.
 */
function kindOf(row: SourceCount): EntitySourceKind {
  return SOURCE_KIND_ORDER.includes(row.kind) ? row.kind : 'unknown';
}

/**
 * Group the flat API rows into display sections, dropping empty kinds. Rows
 * arrive sorted by count and grouping preserves that order.
 */
export function groupSourcesByKind(rows: readonly SourceCount[]): SourceGroup[] {
  return SOURCE_KIND_ORDER.map((kind) => {
    const groupRows = rows
      .filter((row) => kindOf(row) === kind)
      .map((row) => ({ key: row.source, label: sourceLabel(row.source), count: row.count }));

    // Distinct sources can share a short connector label ("Contacts" covers
    // both apple_contacts and google_contacts). Identical rows in one section
    // are indistinguishable, so colliding rows fall back to the full
    // title-cased key instead: "Apple Contacts" / "Google Contacts".
    const labelUses = new Map<string, number>();
    for (const row of groupRows) {
      labelUses.set(row.label, (labelUses.get(row.label) ?? 0) + 1);
    }

    for (const row of groupRows) {
      if ((labelUses.get(row.label) ?? 0) > 1) {
        row.label = titleCaseSourceKey(row.key.replace(/^import:/, ''));
      }
    }

    return {
      kind,
      label: sourceKindLabel(kind),
      rows: groupRows,
    };
  }).filter((group) => group.rows.length > 0);
}
