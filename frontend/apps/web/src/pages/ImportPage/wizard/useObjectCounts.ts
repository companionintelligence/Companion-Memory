import { useEffect, useState } from 'react';

import { useImportApi, type CatalogSource, type ObjectCount } from '../useImportApi';

import { unambiguousImporters } from './useSourceUsage';

/**
 * How much of each memory kind an importer has actually put in `ci.*` —
 * "24K Mail", "1.2M Photos", the numbers next to `PickStep`'s existing
 * icon+label chips.
 *
 * This is the LIVE-TABLE sibling of `useSourceUsage.ts`'s `lastImportedAt`,
 * and exists only because that hook's own docblock explains why a per-source
 * total canNOT be read off import runs: a run records one total for the
 * whole archive (crediting it to every object kind over-claims), a bundle
 * tile covers several importers (already-whole totals would sum again), and
 * runs are not idempotent (a re-import would double a count the push stage
 * already deduplicated). None of that applies to a live `COUNT(*) WHERE
 * source_system = X` — a row IS the kind it is, a bundle can safely sum its
 * members' real counts, and re-running the same archive does not inflate a
 * live table because push upserts on the row's natural key. So this reads
 * `GET /import/sources/object-counts`, never run history.
 *
 * Ambiguity-filtered here, exactly the way `PickStep` already filters
 * `lastImportedAt` before showing "imported ✓": several catalog sources share
 * one importer (`calendar`, `vcard`, `email`, `generic`), so a live count for
 * that importer cannot say which member produced it — crediting it to any one
 * tile would be the identical over-claim, just for a count instead of a date.
 * `unambiguousImporters` already computes exactly this set; reused here
 * rather than reimplemented so the two hooks can never disagree about which
 * importers are safe to name.
 */
export function useObjectCounts(
  catalog: readonly CatalogSource[],
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const api = useImportApi();
  const [counts, setCounts] = useState<ReadonlyMap<string, ReadonlyMap<string, number>>>(new Map());

  useEffect(() => {
    if (!api.ready) {
      return;
    }

    let cancelled = false;

    void api
      .getObjectCounts()
      .then((entries) => {
        if (!cancelled) {
          setCounts(indexObjectCounts(entries, catalog));
        }
      })
      .catch(() => {
        // No numbers at all is the honest fallback for "could not ask" — the
        // tiles fall back to their plain icon+label chips, same as a kind
        // this feature has never wired a count for.
        if (!cancelled) {
          setCounts(new Map());
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, catalog]);

  return counts;
}

/**
 * Raw entries → importer → label → count, keeping only importers this
 * catalog can attribute to exactly one tile.
 *
 * Exported for direct testing: the ambiguity filter is the one rule worth
 * pinning without a DOM, the same way `useSourceUsage.test.ts` tests
 * `creditedSources` directly rather than through a rendered hook.
 */
export function indexObjectCounts(
  entries: readonly ObjectCount[],
  catalog: readonly CatalogSource[],
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const owned = unambiguousImporters(catalog);
  const index = new Map<string, Map<string, number>>();

  for (const entry of entries) {
    if (!owned.has(entry.importer) || entry.count <= 0) {
      continue;
    }

    const byLabel = index.get(entry.importer) ?? new Map<string, number>();

    byLabel.set(entry.label, entry.count);
    index.set(entry.importer, byLabel);
  }

  return index;
}

/**
 * A tile's count for one object label: its own importer's, or a bundle's
 * members summed. `undefined` — never `0` — when nothing is known for ANY of
 * the tile's importers, so the caller can render no number rather than a
 * fabricated zero. A real zero (a source imported, with no rows of this
 * kind) and "never asked" must look the same here, for the identical reason
 * `useSourceUsage` shows no date rather than a blank one: the backend's
 * `GROUP BY` never emits a zero-count row in the first place, so an absent
 * entry always means "no data", not "counted, and it was zero".
 */
export function countFor(
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  importers: readonly string[],
  label: string,
): number | undefined {
  const known = importers
    .map((importer) => counts.get(importer)?.get(label))
    .filter((count): count is number => count != null);

  return known.length === 0 ? undefined : known.reduce((sum, count) => sum + count, 0);
}
