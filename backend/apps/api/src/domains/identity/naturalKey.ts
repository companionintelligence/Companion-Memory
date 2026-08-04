import { createHash } from 'node:crypto';

import { IDENTITY_SPEC_VERSION, type Dimension } from './types';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface NaturalKeyFallback {
  /** Path of the record's source file, relative to the archive root. */
  archiveRelpath: string;
  /** 0-based index of the record within that file, in stable read order. */
  recordOrdinal: number;
}

export interface NaturalKeyInput {
  specVersion?: number;
  /** Namespace, e.g. the connector name. Keeps two sources from colliding. */
  scope: string;
  /** Record kind within the scope, e.g. `media.watch`. */
  kind: string;
  dims: Dimension[];
  fallback: NaturalKeyFallback;
  /**
   * Occurrence counter, shared across one import run. Genuine repeats (the same
   * title watched twice with no distinguishing field) stay distinct instead of
   * silently collapsing.
   */
  seen: Map<string, number>;
}

/**
 * Deterministic natural key — the universal fallback rung (design §4.4).
 *
 * This replaces CI-Import-Tools' `hashItem`, which hashed
 * `dataSource + classification + filename + timestampISO + coords`. For an
 * export whose filename is constant and whose records carry no id (Netflix's
 * `watch.txt`), that reduced to one constant non-temporal dimension, so an
 * entire day of viewing collapsed to a single row and was dropped by
 * `INSERT OR IGNORE`.
 *
 * The rule: a key needs **at least two non-temporal dimensions** to be trusted.
 * Below that it falls back to `archiveRelpath + recordOrdinal`, which is
 * deterministic across re-imports of the same archive and non-temporal by
 * construction — so a double import is a no-op rather than a duplication.
 */
export function buildNaturalKey(input: NaturalKeyInput): string {
  const specVersion = input.specVersion ?? IDENTITY_SPEC_VERSION;

  const present = input.dims.filter(
    (dim) => !dim.temporal && dim.value != null && String(dim.value).trim() !== '',
  );

  const dims: Dimension[] =
    present.length >= 2
      ? present
      : [
          { name: 'archive', value: input.fallback.archiveRelpath, temporal: false },
          { name: 'ordinal', value: input.fallback.recordOrdinal, temporal: false },
        ];

  const payload = [
    String(specVersion),
    input.scope,
    input.kind,
    ...dims
      .slice()
      .sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1))
      .map((dim) => `${dim.name}=${String(dim.value)}`),
  ].join('\0');

  const base = `nat:v${specVersion}:${sha256Hex(payload)}`;
  const occurrence = input.seen.get(base) ?? 0;

  input.seen.set(base, occurrence + 1);

  return occurrence === 0 ? base : `${base}#${occurrence}`;
}
