import { INGEST_REFRESH_COLUMNS, INGEST_SCHEMA_VERSION } from '../ingestRefreshColumns';

/**
 * Guards the centralized ingest conflict-refresh contract. The services import
 * the map (Communication's self-heal UPDATE; Event/Item/BrowserActivity's
 * conflictUpdateColumns), so THIS snapshot is the single place a column-list
 * change surfaces: changing a list must bump INGEST_SCHEMA_VERSION and update
 * the snapshot together.
 */
describe('INGEST_REFRESH_COLUMNS', () => {
  it('covers every bulk-ingest entity, exactly', () => {
    expect(Object.keys(INGEST_REFRESH_COLUMNS).sort()).toEqual(
      ['browser_activity', 'communication', 'content', 'event', 'item'].sort(),
    );
  });

  it('matches the versioned snapshot (bump INGEST_SCHEMA_VERSION when a list changes)', () => {
    expect({ version: INGEST_SCHEMA_VERSION, columns: INGEST_REFRESH_COLUMNS }).toEqual({
      version: 1,
      columns: {
        // CommunicationService.createMany self-heal UPDATE binds its VALUES
        // parameters in this order — keep it in lockstep with the service.
        communication: ['direction', 'participants_metadata', 'content', 'preview', 'subject'],
        event: [],
        item: [],
        content: [],
        browser_activity: [],
      },
    });
  });

  it('never lists identity/arbiter columns (a refresh would clobber provenance)', () => {
    const forbidden = ['id', 'time', 'user_id', 'owner_user_id', 'source_type', 'source_system', 'source_id'];
    for (const columns of Object.values(INGEST_REFRESH_COLUMNS)) {
      for (const column of columns) {
        expect(forbidden).not.toContain(column);
      }
    }
  });
});
