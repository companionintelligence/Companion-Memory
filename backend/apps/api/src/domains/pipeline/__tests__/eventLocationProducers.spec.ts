import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { StageSource } from '../types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY INPUT `promote.place` REQUIRES HAS A SCHEDULED PRODUCER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PROMOTE_PLACE_SOURCE` needs TWO things of an event before it will mint a
 * place and write `location_entity_id`: a coordinate AND a non-blank name. That
 * conjunction is deliberate and correct — "a place needs a name to be a place",
 * per that file — but it means an event missing EITHER input never enters the
 * promoter's candidate set, and an event that never enters it never reaches the
 * map.
 *
 * Only one of the two directions had a scheduled producer:
 *
 *  - name → coordinate: `enrich.geocode`, weekly, over
 *    `location_name IS NOT NULL AND btrim(location_name) <> ''`.
 *  - coordinate → name: NOTHING. `enrich.position_reverse` reverse-geocodes
 *    `ci.position`, a different table, and cannot name a single event.
 *    `PlacePromoteStage`'s own comment says the unnamed rows *"become candidates
 *    the moment `enrich.position_reverse` gives them a name"*, which that stage
 *    can never do. The only coords → name path over `ci.events` was
 *    `MaintenanceOrchestratorService.runGeocodeLeg` with `direction: 'reverse'`
 *    and the `reverse_geocode` CLI leg — both operator-triggered, neither on a
 *    cron, neither chained from an import.
 *
 * So an event that arrived with a MEASUREMENT and no label (photo EXIF GPS, a
 * GPX check-in, a geotagged post) was stranded permanently on any appliance
 * nobody drove by hand. On the appliance this was written against, 79 of the 91
 * events carrying coordinates were in exactly that state, and 2 were linked to a
 * place.
 *
 * This file is the standing guard on the pair, not on one stage. It DISCOVERS
 * the applicability predicates off disk rather than importing a list, for the
 * reason `stageWiring.spec.ts` gives at length: a test that names the stages it
 * knows about passes on the day the missing one is still missing, which is the
 * only day it matters. Delete a producer, or narrow its predicate until it stops
 * covering its half of the pair, and this fails by name.
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const STAGES_DIR = join(__dirname, '..', 'stages');

/** Every `.ts` file under `stages/`, tests excluded. Recursive: `stages/<phase>/`. */
function stageSourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') {
      continue;
    }

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...stageSourceFiles(full));

      continue;
    }

    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }

  return found;
}

interface DiscoveredSource {
  /** Path relative to `stages/`, so a failure message points at a file. */
  file: string;
  exportName: string;
  source: StageSource;
}

/**
 * Every exported `StageSource` under `stages/`.
 *
 * Duck-typed on the five fields the sweep binds, because interfaces are erased
 * at runtime and the alternative — a hand-kept list of `*_SOURCE` names — is the
 * thing this file exists not to be. Constructing the stage classes (what
 * `stageWiring.spec.ts` does) would work too and costs a proxy-stub apparatus
 * this file has no other use for: the sources are module-level constants.
 */
function discoverSources(): DiscoveredSource[] {
  const discovered: DiscoveredSource[] = [];

  for (const file of stageSourceFiles(STAGES_DIR)) {
    const loaded = jest.requireActual<Record<string, unknown>>(file);

    for (const [exportName, exported] of Object.entries(loaded)) {
      if (typeof exported !== 'object' || exported == null) {
        continue;
      }

      const candidate = exported as Partial<StageSource>;

      if (
        typeof candidate.schema === 'string' &&
        typeof candidate.table === 'string' &&
        typeof candidate.idColumn === 'string' &&
        typeof candidate.userColumn === 'string'
      ) {
        discovered.push({
          file: file.slice(STAGES_DIR.length + 1),
          exportName,
          source: candidate as StageSource,
        });
      }
    }
  }

  return discovered;
}

const EVENT_SOURCES = discoverSources().filter(
  ({ source }) => source.schema === 'ci' && source.table === 'events',
);

/** A human-readable list for a failure message: `enrich/GeocodeStage.ts:GEOCODE_SOURCE`. */
function describeAll(sources: DiscoveredSource[]): string {
  return sources.map(({ file, exportName }) => `${file}:${exportName}`).join(', ');
}

const requiresCoordinates = ({ source }: DiscoveredSource): boolean =>
  /location_coordinates\s+IS\s+NOT\s+NULL/i.test(source.predicate ?? '');

const mentionsName = ({ source }: DiscoveredSource): boolean => /location_name/i.test(source.predicate ?? '');

/* ===================================================================== *
 * Tests
 * ===================================================================== */

describe('ci.events location producers', () => {
  it('found the event sources at all', () => {
    // A discovery test that discovers nothing passes every assertion below
    // vacuously, which is the failure mode of every from-disk test. `ci.events`
    // is the most-swept table in the pipeline; if this is empty, the walk is
    // broken, not the pipeline.
    expect(EVENT_SOURCES.length).toBeGreaterThan(2);
  });

  it('has a scheduled producer for the NAME → COORDINATE direction', () => {
    // `enrich.geocode`. This half has always existed; it is asserted so the pair
    // is stated as a pair rather than the file only ever noticing one gap.
    const forward = EVENT_SOURCES.filter(
      (candidate) => mentionsName(candidate) && !requiresCoordinates(candidate),
    );

    expect(describeAll(forward)).not.toEqual('');
  });

  it('has a scheduled producer for the COORDINATE → NAME direction', () => {
    // THE GAP. A predicate that requires a coordinate and says NOTHING about the
    // name is the only shape that can select a measured-but-unlabelled event:
    //
    //  - requiring a name excludes exactly the rows that need one;
    //  - requiring `location_name IS NULL` would be the ratchet instead —
    //    `location_name` is the OUTPUT column, so the first answer any provider
    //    ever wrote would be frozen for the life of the appliance. Whether the
    //    stage has run belongs in `ci.pipeline_state` and nowhere else, which is
    //    why "does not mention the column at all" is the assertion rather than
    //    "checks it is null".
    const reverse = EVENT_SOURCES.filter(
      (candidate) => requiresCoordinates(candidate) && !mentionsName(candidate),
    );

    expect(
      reverse.length > 0
        ? describeAll(reverse)
        : `no stage over ci.events selects on coordinates alone, so an event with a measured ` +
            `coordinate and no label can never be named, never satisfies PROMOTE_PLACE_SOURCE, and ` +
            `never reaches the map. Sources found: ${describeAll(EVENT_SOURCES)}`,
    ).not.toMatch(/^no stage/);
  });

  it('keeps both producers off the ledger — applicability, never completion', () => {
    // `StageRegistry.assertApplicabilityPredicate` rejects a predicate that
    // names `ci.pipeline_state`; nothing can reject one that reads its own
    // output column, which is the same ratchet wearing the source table's
    // clothes. Asserted here for every event source at once because the two
    // location producers write each other's selection columns: the forward
    // stage's output is the reverse stage's input and vice versa, so a
    // nullability guard in either one silently freezes both.
    for (const { file, exportName, source } of EVENT_SOURCES) {
      expect(`${file}:${exportName}:${source.predicate ?? ''}`).not.toMatch(/pipeline_state/i);
      expect(`${file}:${exportName}:${source.predicate ?? ''}`).not.toMatch(
        /location_(name|coordinates|entity_id)\s+IS\s+NULL/i,
      );
    }
  });
});
