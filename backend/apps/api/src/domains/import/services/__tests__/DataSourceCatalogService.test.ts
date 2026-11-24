import { WIZARD_BUNDLES } from '../../sources/bundles';
import { WIZARD_SOURCES } from '../../sources/guides';
import { DataSourceCatalogService } from '../DataSourceCatalogService';

/**
 * The SOURCE-keyed catalog behind the wizard's picker.
 *
 * Three properties matter and each has a failure mode that would be silent:
 * completeness (a dropped source simply vanishes from the picker), order (the
 * array is deliberately tier-then-ecosystem, and a re-sort anywhere between
 * here and the grid quietly undoes the curation), and the effective-importer
 * fallback (a source without its own parser attributes to itself, and getting
 * that wrong misfiles every detected `data_sources` badge).
 */
describe('DataSourceCatalogService.catalog', () => {
  const service = new DataSourceCatalogService();
  const entries = service.catalog();

  it('serves every authored source', () => {
    expect(entries).toHaveLength(WIZARD_SOURCES.length);
  });

  it('preserves the curated array order exactly', () => {
    expect(entries.map((entry) => entry.id)).toEqual(WIZARD_SOURCES.map((source) => source.id));
  });

  it('falls back to the source id when no importer is named', () => {
    const withImporter = WIZARD_SOURCES.find((source) => source.importer != null);
    const withoutImporter = WIZARD_SOURCES.find((source) => source.importer == null);

    // Both shapes exist in the authored data; if one stops existing, this test
    // should fail loudly rather than silently cover less.
    expect(withImporter).toBeDefined();
    expect(withoutImporter).toBeDefined();

    const importerEntry = entries.find((entry) => entry.id === withImporter!.id);
    const fallbackEntry = entries.find((entry) => entry.id === withoutImporter!.id);

    expect(importerEntry?.importer).toBe(withImporter!.importer);
    expect(fallbackEntry?.importer).toBe(withoutImporter!.id);
  });

  it('exposes readiness so the picker can badge coming-soon sources', () => {
    // The authored set currently has both ready and unready sources; the picker
    // sorts unready last and badges them, which only works if the flag arrives.
    expect(entries.some((entry) => entry.importerReady)).toBe(true);
    expect(entries.some((entry) => !entry.importerReady)).toBe(true);
  });

  it('keeps internal plumbing out of the projection', () => {
    // `tier` is encoded by array order; the rest is backend-only detail. A key
    // that leaks invites the frontend to grow logic the backend owns.
    for (const entry of entries) {
      expect(entry).not.toHaveProperty('tier');
      expect(entry).not.toHaveProperty('inboxPath');
      expect(entry).not.toHaveProperty('signature');
      expect(entry).not.toHaveProperty('provenance');
      expect(entry).not.toHaveProperty('alsoImporters');
    }
  });
});

/**
 * The bundle projection carries everything the export card renders. The two
 * optional sections are the easy ones to drop: a bundle whose `stepsTitle` or
 * `altPath` went missing here would still render, just with the default
 * heading and no second path, and nothing would say so.
 */
describe('DataSourceCatalogService.bundles', () => {
  const service = new DataSourceCatalogService();
  const entries = service.bundles();

  it('serves every authored bundle in order, with its members', () => {
    expect(entries.map((entry) => entry.id)).toEqual(WIZARD_BUNDLES.map((bundle) => bundle.id));
    expect(entries.map((entry) => entry.members)).toEqual(WIZARD_BUNDLES.map((bundle) => bundle.members));
  });

  it('carries the steps heading and the alternative path through unchanged', () => {
    for (const bundle of WIZARD_BUNDLES) {
      const entry = entries.find((candidate) => candidate.id === bundle.id);

      expect(entry?.stepsTitle).toBe(bundle.stepsTitle);
      expect(entry?.altPath).toEqual(bundle.altPath);
    }

    // At least one authored bundle exercises the heading, so this is not vacuous.
    expect(WIZARD_BUNDLES.some((bundle) => bundle.stepsTitle != null)).toBe(true);
  });
});
