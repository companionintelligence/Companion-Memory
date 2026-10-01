import { SOURCE_LOCATION_VOCABULARY } from '@ci/domains/memory';

import { EstimateLocationStage } from '../stages/enrich/EstimateLocationStage';
import { NAME_OWNERSHIP_SOURCES } from '../stages/enrich/EventReverseStage';
import { OVERWRITABLE_LOCATION_SOURCES } from '../stages/enrich/GeocodeStage';
import { PROMOTE_PLACE_STAGE_ID } from '../stages/promote/PlacePromoteStage';

/**
 * The location refresh (memory/services/sourceLocationMerge.ts) reads the
 * pipeline's own marks on a row to tell what a stage wrote from what the source
 * or a person did: `metadata.location_source` and `metadata.promote.stage`.
 * Memory cannot import the stages, so it holds a copy of that vocabulary, and a
 * copy that drifts fails without a sound: a tag the stage writes and the merge no
 * longer recognises reads as somebody's edit, and the row stops following its
 * source.
 *
 * Each assertion below is against what the STAGE declares or writes, not against
 * another copy.
 */
describe('the location tags the refresh reads', () => {
  const { geocoded, approximate, estimated, reverseGeocoded, placeLinkStage } = SOURCE_LOCATION_VOCABULARY;

  it('names the tags enrich.geocode may overwrite: its own two, and the estimator’s', () => {
    for (const tag of [geocoded, approximate, estimated]) {
      expect(OVERWRITABLE_LOCATION_SOURCES.has(tag)).toBe(true);
    }
  });

  it('is the one tag enrich.event_reverse owns the name for', () => {
    expect([...NAME_OWNERSHIP_SOURCES]).toEqual([reverseGeocoded]);
  });

  it('does not treat the tag the reverse stage owns as one the geocode stage may overwrite', () => {
    // A reverse-geocoded row has a MEASURED point and a derived name; the refresh reads
    // it as "name derived from the point", never as a geocode of the name.
    expect(OVERWRITABLE_LOCATION_SOURCES.has(reverseGeocoded)).toBe(false);
  });

  it('names the stage that writes the place link', () => {
    expect(placeLinkStage).toBe(PROMOTE_PLACE_STAGE_ID);
  });

  it('is the tag enrich.estimate_location writes, read off the statement it runs', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        statements.push({ sql, params });

        // The slice's rows, then the estimate's own UPDATE.
        return sql.includes('WITH estimated')
          ? [{ event_id: 'e1', donor: 'position', donor_id: '1', delta_seconds: 5 }]
          : [
              {
                id: 'e1',
                has_coordinates: false,
                location_source: null,
                has_location_name: false,
                is_deleted: false,
                is_predicted: false,
                did_not_happen: false,
              },
            ];
      }),
    };
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const stage = new EstimateLocationStage(dataSource as never, logger as never);

    await stage.run({ userId: 'u1' } as never, ['e1']);

    const write = statements.find((statement) => statement.sql.includes('WITH estimated'));

    expect(write?.sql).toContain(`jsonb_build_object('location_source', $5::text)`);
    expect(write?.params[4]).toBe(estimated);
  });
});
