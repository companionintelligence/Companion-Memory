import {
  INGEST_TIME_SOURCE,
  appearanceParams,
  hasDateWindow,
  mapAppearanceRows,
  personAppearanceCountSql,
  personAppearanceListSql,
  placeAppearanceCountSql,
  placeAppearanceListSql,
} from './appearanceBrowse';
import { EVENT_HAPPENED_SQL } from './eventHappened';

describe('appearanceBrowse', () => {
  it('treats either bound of a date filter as a window', () => {
    expect(hasDateWindow({})).toBe(false);
    expect(hasDateWindow({ startTime: new Date() })).toBe(true);
    expect(hasDateWindow({ endTime: new Date() })).toBe(true);
  });

  it('maps rows onto identifiers carrying sortTime so SearchResolver can stamp appearedAt', () => {
    const appearedAt = new Date('2024-03-04T12:00:00Z');
    const [person] = mapAppearanceRows([{ id: 'p1', appearedAt }], 'person');

    expect(person).toEqual({ id: 'p1', type: 'person', sortTime: appearedAt });
  });

  it('excludes ingest wall-clock events from person and place appearance SQL', () => {
    expect(INGEST_TIME_SOURCE).toBe('ingest');
    expect(personAppearanceListSql()).toContain("time_source IS DISTINCT FROM 'ingest'");
    expect(placeAppearanceListSql()).toContain("time_source IS DISTINCT FROM 'ingest'");
    expect(personAppearanceCountSql()).toContain("time_source IS DISTINCT FROM 'ingest'");
    expect(placeAppearanceCountSql()).toContain("time_source IS DISTINCT FROM 'ingest'");
  });

  it('dates people from events (organizer or participant) and communications (from or to)', () => {
    const sql = personAppearanceListSql();

    expect(sql).toContain('organizer_entity_id');
    expect(sql).toContain('unnest(e.participant_entity_ids)');
    expect(sql).toContain('from_entity_id');
    expect(sql).toContain('unnest(c.to_entity_ids)');
    expect(sql).toContain('MIN(at)');
  });

  it('dates places from events.location_entity_id only — not a fan-out of every visit', () => {
    const sql = placeAppearanceListSql();

    expect(sql).toContain('location_entity_id');
    expect(sql).toContain('MIN(at)');
    expect(sql).not.toContain('communications');
  });

  it('dates places only from events that happened, on the alias that rule is written for', () => {
    // The filtering is SQL, so what it does is proven against Postgres in
    // __tests__/PlaceService.appearance.integration.spec.ts. This pins that the
    // list and the count both apply it, over `event`, and bring no bind
    // parameter of their own.
    for (const sql of [placeAppearanceListSql(), placeAppearanceCountSql()]) {
      expect(sql).toContain('FROM ci.events event');
      expect(sql).toContain(EVENT_HAPPENED_SQL);
      expect(sql).not.toMatch(/\$[7-9]/);
    }
  });

  it('pages the list by (appeared_at, entity_id) so the cursor matches SearchResolver', () => {
    expect(personAppearanceListSql('DESC')).toContain('appeared_at DESC');
    expect(personAppearanceListSql('ASC')).toContain('appeared_at ASC');
    expect(appearanceParams('user-1', { limit: 30 })[5]).toBe(30);
  });
});
