import { Injectable } from '@nestjs/common';

// Importing the barrel REGISTERS every parser as a side effect — that is what
// populates the registry this service reads. It is imported here and nowhere
// else on the API path, so the cost is paid once, in the one place that needs
// the catalog to be complete. `domains/import/index.ts` deliberately does not
// re-export it for the same reason.
import '../datasources';
import { allDataSources, type DataSource } from '../datasources/registry';
import { WIZARD_BUNDLES, type WizardBundle } from '../sources/bundles';
import { WIZARD_SOURCES, type WizardSource } from '../sources/guides';

/** One importer, as the catalog describes it. */
export interface DataSourceSummary {
  /** Stable snake_case id. This is what `staged_items.data_source` records. */
  name: string;
  title: string;
  description: string;
  /** Icon filename the frontend resolves; not a URL. */
  icon: string;
  /**
   * Recognized but not yet implemented. Listed rather than hidden so someone
   * looking for their export learns the appliance knows about it, instead of
   * concluding it is unsupported and giving up.
   */
  stub: boolean;
  /** Can read an export off disk — the archive-import path. */
  supportsFiles: boolean;
  /** Can pull from a live account, given credentials. */
  supportsApi: boolean;
  /**
   * How to get this export out of the service that holds it.
   *
   * The reason someone is on the import page at all is usually that they do not
   * know where their data lives. Shipping the instructions with the catalog puts
   * the answer where the question is asked, instead of in documentation they
   * would have to go looking for.
   */
  guide: SourceGuide | null;
}

/** The authored export instructions for one source. */
export interface SourceGuide {
  title: string;
  blurb: string;
  ecosystem: string;
  category: string;
  /** Roughly how long between requesting the export and being able to download it. */
  wait: string;
  /** How the export is obtained: web-export, app-export, local-file, manual-upload, api. */
  acquisition?: string;
  /** Deep link to the export page, when the service has a stable one. */
  url?: string;
  stepsTitle?: string;
  steps: string[];
  /** A second way to get the data, when the service offers one with different tradeoffs. */
  altPath?: { title: string; url?: string; steps: string[] };
  /** What the importer actually reads once the archive is open. */
  expectedFormat?: string;
  /** What lands in the timeline from this source. */
  whatImported?: string[];
  /** Worth knowing BEFORE spending an hour exporting. */
  caveats?: string[];
  /** Loose addenda, rendered without a heading. */
  notes?: string[];
}

/**
 * One authored source, projected for the wizard's picker and export cards.
 *
 * SOURCE-keyed where {@link DataSourceSummary} is IMPORTER-keyed, and the
 * distinction is the whole reason this exists: several sources share the
 * `generic` parser, and a source whose importer is not written yet still
 * belongs in the picker (with its "coming soon" badge) — hiding it reads as
 * "unsupported" and ends the conversation. The wizard picks over SERVICES a
 * person recognizes, not over parsers.
 */
export interface SourceCatalogEntry {
  /** Stable authored id (`gmail`, `google_photos`, …). */
  id: string;
  title: string;
  blurb: string;
  ecosystem: string;
  category: string;
  acquisition: string;
  wait: string;
  url?: string;
  stepsTitle?: string;
  steps: string[];
  altPath?: { title: string; url?: string; steps: string[] };
  expectedFormat?: string;
  whatImported?: string[];
  caveats?: string[];
  notes?: string[];
  /**
   * Effective importer name (`importer ?? id`) — what a run's detected
   * `data_sources` records for this source's rows.
   */
  importer: string;
  importerReady: boolean;
}

/**
 * One export bundle, as the wizard shows it: a single picker button and export
 * card standing for several catalog sources (`members`) that arrive in the one
 * archive. See `sources/bundles.ts`.
 */
export interface BundleCatalogEntry {
  id: string;
  ecosystem: string;
  title: string;
  blurb: string;
  url?: string;
  stepsTitle?: string;
  steps: string[];
  /** A second way to get the data, when the platform offers one with different tradeoffs. */
  altPath?: { title: string; url?: string; steps: string[] };
  members: string[];
  notes?: string[];
}

/**
 * What this appliance can import.
 *
 * Read from the in-memory registry rather than a table: the registry IS the
 * source of truth for what can be imported, and a catalog table would be a
 * second copy that drifts the first time someone adds a parser without a
 * migration.
 */
@Injectable()
export class DataSourceCatalogService {
  /** Every registered importer, ordered by name. */
  list(): DataSourceSummary[] {
    return allDataSources().map(toSummary);
  }

  /** One importer by its stable name, or null. */
  find(name: string): DataSourceSummary | null {
    const match = allDataSources().find((source) => source.name === name);

    return match ? toSummary(match) : null;
  }

  /**
   * Every authored source, in WIZARD_SOURCES order.
   *
   * The array is deliberately sorted tier-then-ecosystem so the wizard reads
   * best-first within a section — a straight `.map` preserves that; do not
   * re-sort here or in the frontend.
   */
  catalog(): SourceCatalogEntry[] {
    return WIZARD_SOURCES.map(toCatalogEntry);
  }

  /** The export bundles, in authored order. */
  bundles(): BundleCatalogEntry[] {
    return WIZARD_BUNDLES.map(toBundleEntry);
  }
}

function toBundleEntry(bundle: WizardBundle): BundleCatalogEntry {
  return {
    id: bundle.id,
    ecosystem: bundle.ecosystem,
    title: bundle.title,
    blurb: bundle.blurb,
    url: bundle.url,
    stepsTitle: bundle.stepsTitle,
    steps: bundle.steps,
    altPath: bundle.altPath,
    members: bundle.members,
    notes: bundle.notes,
  };
}

/**
 * The projection deliberately DROPS `tier` (encoded by array order),
 * `inboxPath`, `signature`, `provenance` and `alsoImporters` — internal
 * plumbing that would invite the frontend to grow logic the backend owns.
 */
function toCatalogEntry(source: WizardSource): SourceCatalogEntry {
  return {
    id: source.id,
    title: source.title,
    blurb: source.blurb,
    ecosystem: source.ecosystem,
    category: source.category,
    acquisition: source.acquisition,
    wait: source.wait,
    url: source.url,
    stepsTitle: source.stepsTitle,
    steps: source.steps,
    altPath: source.altPath,
    expectedFormat: source.expectedFormat,
    whatImported: source.whatImported,
    caveats: source.caveats,
    notes: source.notes,
    importer: source.importer ?? source.id,
    importerReady: source.importerReady,
  };
}

/**
 * Guides indexed by the importer they feed.
 *
 * A guide names its importer explicitly when they differ — several sources share
 * the `generic` parser, and an ecosystem's one export can feed more than one
 * importer (an Apple Contacts archive resolves to both `vcard` and
 * `apple_contacts`). Built once: the registry does not change at runtime.
 */
const GUIDES_BY_IMPORTER = new Map<string, WizardSource>(
  WIZARD_SOURCES.flatMap((source) => {
    const keys = [source.importer ?? source.id, ...(source.alsoImporters ?? [])];

    return keys.map((key) => [key, source] as const);
  }),
);

function toGuide(source: WizardSource | undefined): SourceGuide | null {
  if (source == null) {
    return null;
  }

  return {
    title: source.title,
    blurb: source.blurb,
    ecosystem: source.ecosystem,
    category: source.category,
    wait: source.wait,
    acquisition: source.acquisition,
    url: source.url,
    stepsTitle: source.stepsTitle,
    steps: source.steps,
    altPath: source.altPath,
    expectedFormat: source.expectedFormat,
    whatImported: source.whatImported,
    caveats: source.caveats,
    notes: source.notes,
  };
}

function toSummary(source: DataSource): DataSourceSummary {
  return {
    name: source.name,
    title: source.title,
    description: source.description,
    icon: source.icon,
    stub: source.stub === true,
    supportsFiles: source.newFileImporter != null,
    supportsApi: source.newAPIImporter != null,
    guide: toGuide(GUIDES_BY_IMPORTER.get(source.name)),
  };
}
