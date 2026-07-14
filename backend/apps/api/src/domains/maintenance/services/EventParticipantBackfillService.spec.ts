import { EventParticipantBackfillService } from './EventParticipantBackfillService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const ORGANIZER = '00000000-0000-0000-0000-0000000000b1';
const ATTENDEE_1 = '00000000-0000-0000-0000-0000000000c1';
const ATTENDEE_2 = '00000000-0000-0000-0000-0000000000c2';

interface FakeRow {
  event_id: string;
  start_time: Date;
  organizer_entity_id: string | null;
  participant_entity_ids: string[] | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Build a DataSource whose `query` serves the candidate SELECT once, returns
 * [] for any later SELECT (so the keyset loop terminates after one page), and
 * records UPDATE calls for assertion. No transaction wrapper needed — the
 * event backfill writes UPDATEs directly off the DataSource (the comms
 * backfill's `transaction` was for the TimescaleDB decompression override,
 * which doesn't apply to non-hypertable ci.events).
 */
function makeDataSource(rows: FakeRow[]) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  let selectServed = false;

  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('UPDATE ci.events')) {
      updates.push({ sql, params });

      return [];
    }

    if (sql.includes('FROM ci.events')) {
      if (!selectServed) {
        selectServed = true;

        return rows;
      }

      return [];
    }

    return [];
  });

  return { dataSource: { query }, updates, query };
}

function makeIdentifierService(map: Record<string, string>) {
  return {
    findEntityIdsByIdentifiers: jest.fn(
      async (_userId: string, keys: Array<{ kind: string; valueNormalized: string }>) => {
        const out = new Map<string, string>();
        for (const key of keys) {
          const composite = `${key.kind}:${key.valueNormalized}`;
          if (map[composite]) {
            out.set(composite, map[composite]);
          }
        }

        return out;
      },
    ),
  };
}

function makeService(rows: FakeRow[], identifierMap: Record<string, string>) {
  const ds = makeDataSource(rows);
  const ids = makeIdentifierService(identifierMap);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new EventParticipantBackfillService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ds.dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ids as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, ds, ids };
}

describe('EventParticipantBackfillService.backfill', () => {
  it('resolves organizer + attendees from Google-shape metadata in one UPDATE', async () => {
    const rows: FakeRow[] = [
      {
        event_id: 'event-1',
        start_time: new Date('2026-06-01T10:00:00.000Z'),
        organizer_entity_id: null,
        participant_entity_ids: null,
        metadata: {
          organizerEmail: 'Alice@Example.com',
          organizerName: 'Alice',
          participants: [
            { email: 'Alice@Example.com', name: 'Alice', isOrganizer: true, responseStatus: 'accepted' },
            { email: 'bob@example.com', name: 'Bob', isOrganizer: false, responseStatus: 'accepted' },
            { email: 'carol@example.com', name: 'Carol', isOrganizer: false, responseStatus: 'tentative' },
          ],
        },
      },
    ];

    const { service, ds, ids } = makeService(rows, {
      'email:alice@example.com': ORGANIZER,
      'email:bob@example.com': ATTENDEE_1,
      'email:carol@example.com': ATTENDEE_2,
    });

    const result = await service.backfill(USER);

    expect(result).toMatchObject({
      examined: 1,
      organizersLinked: 1,
      participantsLinked: 1,
      pages: 1,
    });

    // ONE batched identifier lookup for the page.
    expect(ids.findEntityIdsByIdentifiers).toHaveBeenCalledTimes(1);

    // ONE UPDATE, parallel arrays for ids/organizers/participants (jsonb).
    expect(ds.updates).toHaveLength(1);
    const { sql, params } = ds.updates[0];
    expect(sql).toContain('UPDATE ci.events');
    expect(sql).toContain('e.event_id = u.id');
    expect(params[0]).toBe(USER);
    expect(params[1]).toEqual(['event-1']);
    expect(params[2]).toEqual([ORGANIZER]);
    // Attendees include the organizer too — that's fine, the index resolves
    // them all and we dedupe the resulting uuid array.
    expect(params[3]).toEqual([JSON.stringify([ORGANIZER, ATTENDEE_1, ATTENDEE_2])]);
  });

  it('resolves an Outlook-shape event (organizer only, no participants in metadata)', async () => {
    const rows: FakeRow[] = [
      {
        event_id: 'event-1',
        start_time: new Date('2026-06-01T10:00:00.000Z'),
        organizer_entity_id: null,
        participant_entity_ids: null,
        metadata: {
          organizerEmail: 'dave@example.com',
          organizerName: 'Dave',
          participantCount: 4,
          // No `participants` array — Outlook transformer stores only the count.
        },
      },
    ];

    const { service, ds } = makeService(rows, { 'email:dave@example.com': ORGANIZER });

    const result = await service.backfill(USER);

    expect(result.organizersLinked).toBe(1);
    expect(result.participantsLinked).toBe(0);
    expect(ds.updates).toHaveLength(1);
    const { params } = ds.updates[0];
    expect(params[2]).toEqual([ORGANIZER]);
    // No participants resolved -> ride as null jsonb so the CASE leaves the column alone.
    expect(params[3]).toEqual([null]);
  });

  it('skips a row entirely when nothing matches (no stub creation, no UPDATE row)', async () => {
    const rows: FakeRow[] = [
      {
        event_id: 'event-1',
        start_time: new Date('2026-06-01T10:00:00.000Z'),
        organizer_entity_id: null,
        participant_entity_ids: null,
        metadata: {
          organizerEmail: 'unknown@example.com',
          participants: [{ email: 'no-match@example.com', name: 'Nobody' }],
        },
      },
    ];

    const { service, ds } = makeService(rows, {}); // empty identifier index

    const result = await service.backfill(USER);

    expect(result.examined).toBe(1);
    expect(result.organizersLinked).toBe(0);
    expect(result.participantsLinked).toBe(0);
    // Nothing to write — the page contributes no rows to the UPDATE, so the
    // service skips the SQL call entirely.
    expect(ds.updates).toHaveLength(0);
  });

  it('only fills the missing side (organizer already set -> resolves participants only)', async () => {
    const rows: FakeRow[] = [
      {
        event_id: 'event-1',
        start_time: new Date('2026-06-01T10:00:00.000Z'),
        organizer_entity_id: ORGANIZER, // already linked
        participant_entity_ids: null,
        metadata: {
          organizerEmail: 'alice@example.com',
          participants: [{ email: 'bob@example.com' }],
        },
      },
    ];

    const { service, ds } = makeService(rows, {
      // Even though Alice maps, the organizer is already set; the lookup must
      // not produce a write for it.
      'email:alice@example.com': 'must-not-overwrite',
      'email:bob@example.com': ATTENDEE_1,
    });

    const result = await service.backfill(USER);

    expect(result.organizersLinked).toBe(0);
    expect(result.participantsLinked).toBe(1);
    expect(ds.updates).toHaveLength(1);
    const { params } = ds.updates[0];
    expect(params[2]).toEqual([null]); // organizerId null -> COALESCE keeps existing
    expect(params[3]).toEqual([JSON.stringify([ATTENDEE_1])]);
  });

  it('writes a partial participant set when only some attendees resolve', async () => {
    const rows: FakeRow[] = [
      {
        event_id: 'event-1',
        start_time: new Date('2026-06-01T10:00:00.000Z'),
        organizer_entity_id: null,
        participant_entity_ids: null,
        metadata: {
          participants: [{ email: 'known@example.com' }, { email: 'unknown@example.com' }],
        },
      },
    ];

    const { service, ds } = makeService(rows, { 'email:known@example.com': ATTENDEE_1 });

    const result = await service.backfill(USER);

    expect(result.participantsLinked).toBe(1);
    expect(ds.updates).toHaveLength(1);
    expect(ds.updates[0].params[3]).toEqual([JSON.stringify([ATTENDEE_1])]);
  });

  it('falls back to PascalCase / `from` / `attendees` for non-canonical metadata shapes', async () => {
    const rows: FakeRow[] = [
      {
        event_id: 'event-1',
        start_time: new Date('2026-06-01T10:00:00.000Z'),
        organizer_entity_id: null,
        participant_entity_ids: null,
        metadata: {
          // Importer-flattened email event: capitalized keys, no organizerEmail.
          From: 'alice@example.com',
          Attendees: ['bob@example.com', { emailAddress: { address: 'carol@example.com' } }],
        },
      },
    ];

    const { service, ds } = makeService(rows, {
      'email:alice@example.com': ORGANIZER,
      'email:bob@example.com': ATTENDEE_1,
      'email:carol@example.com': ATTENDEE_2,
    });

    const result = await service.backfill(USER);

    expect(result.organizersLinked).toBe(1);
    expect(result.participantsLinked).toBe(1);
    const { params } = ds.updates[0];
    expect(params[2]).toEqual([ORGANIZER]);
    expect(params[3]).toEqual([JSON.stringify([ATTENDEE_1, ATTENDEE_2])]);
  });

  it('dedupes identifiers across rows and the resolved participant array per row', async () => {
    const rows: FakeRow[] = [
      {
        event_id: 'event-1',
        start_time: new Date('2026-06-01T10:00:00.000Z'),
        organizer_entity_id: null,
        participant_entity_ids: null,
        metadata: {
          organizerEmail: 'alice@example.com',
          // The same attendee listed twice — only one uuid in the final array.
          participants: [{ email: 'bob@example.com' }, { email: 'bob@example.com' }],
        },
      },
      {
        event_id: 'event-2',
        start_time: new Date('2026-06-01T09:00:00.000Z'),
        organizer_entity_id: null,
        participant_entity_ids: null,
        metadata: {
          // Same organizer/attendee as event-1 — the per-page identifier set
          // should still only request each (kind, value) once.
          organizerEmail: 'alice@example.com',
          participants: [{ email: 'bob@example.com' }],
        },
      },
    ];

    const { service, ds, ids } = makeService(rows, {
      'email:alice@example.com': ORGANIZER,
      'email:bob@example.com': ATTENDEE_1,
    });

    await service.backfill(USER);

    // Two distinct identifiers across both rows -> a 2-key batch lookup.
    expect(ids.findEntityIdsByIdentifiers).toHaveBeenCalledTimes(1);
    const keysArg = ids.findEntityIdsByIdentifiers.mock.calls[0][1];
    expect(keysArg).toHaveLength(2);

    expect(ds.updates).toHaveLength(1);
    const { params } = ds.updates[0];
    expect(params[1]).toEqual(['event-1', 'event-2']);
    expect(params[2]).toEqual([ORGANIZER, ORGANIZER]);
    // event-1's duplicate bob is squashed.
    expect(params[3]).toEqual([JSON.stringify([ATTENDEE_1]), JSON.stringify([ATTENDEE_1])]);
  });

  it('returns an empty result when there are no candidate rows', async () => {
    const { service, ds, ids } = makeService([], {});

    const result = await service.backfill(USER);

    expect(result).toEqual({ examined: 0, organizersLinked: 0, participantsLinked: 0, pages: 0 });
    // The SELECT runs once and returns 0 rows; no identifier lookup, no UPDATE.
    expect(ds.query).toHaveBeenCalledTimes(1);
    expect(ids.findEntityIdsByIdentifiers).not.toHaveBeenCalled();
    expect(ds.updates).toHaveLength(0);
  });

  it('invokes onProgress once per page with cumulative counts', async () => {
    const rows: FakeRow[] = [
      {
        event_id: 'event-1',
        start_time: new Date('2026-06-01T10:00:00.000Z'),
        organizer_entity_id: null,
        participant_entity_ids: null,
        metadata: { organizerEmail: 'alice@example.com' },
      },
    ];

    const { service } = makeService(rows, { 'email:alice@example.com': ORGANIZER });
    const ticks: Array<Record<string, number>> = [];

    const result = await service.backfill(USER, {
      onProgress: (p) => ticks.push({ ...p }),
    });

    expect(ticks).toEqual([{ examined: 1, organizersLinked: 1, participantsLinked: 0, pagesDone: 1 }]);
    expect(result).toEqual({ examined: 1, organizersLinked: 1, participantsLinked: 0, pages: 1 });
  });
});
