import { CommunicationParticipantLinkListener } from './CommunicationParticipantLinkListener';

const USER = '00000000-0000-0000-0000-0000000000aa';
const COMM_ID = '00000000-0000-0000-0000-0000000000cc';
const COMM_TIME = new Date('2026-06-28T12:00:00.000Z');
const EXISTING_FROM = '00000000-0000-0000-0000-0000000000b1';
const NEW_TO_1 = '00000000-0000-0000-0000-0000000000c1';

interface FakeCommunication {
  id: string;
  time: Date;
  userId: string | null;
  fromEntityId: string | null;
  toEntityIds: string[] | null;
  participantsMetadata: Record<string, unknown> | null;
}

function makeCommunicationService(row: FakeCommunication | null) {
  return {
    findById: jest.fn(async (_context: unknown, id: string) => (row && row.id === id ? row : null)),
  };
}

interface IngestEntityCapture {
  key: string;
  entityType: string;
  name?: string | null;
  sourceSystem: string;
  properties?: Record<string, unknown> | null;
}

function makeIdentifierService(initial: Record<string, string>) {
  // The service performs two lookups per run (pre-ingest + post-ingest). The
  // post-ingest lookup must reflect any keys the ingest mock landed, so we
  // expose the map for tests to mutate.
  const indexedByComposite = new Map(Object.entries(initial));

  return {
    indexedByComposite,
    findEntityIdsByIdentifiers: jest.fn(
      async (_userId: string, keys: Array<{ kind: string; valueNormalized: string }>) => {
        const out = new Map<string, string>();
        for (const key of keys) {
          const composite = `${key.kind}:${key.valueNormalized}`;
          const id = indexedByComposite.get(composite);
          if (id != null) {
            out.set(composite, id);
          }
        }

        return out;
      },
    ),
  };
}

function makeIngestService(
  indexedByComposite: Map<string, string>,
  // (composite -> entity_id) for any new entities the test wants ingest to "create".
  toAssign: Record<string, string> = {},
) {
  return {
    ingest: jest.fn(
      async (
        _context: { userId: string },
        input: { entities: IngestEntityCapture[]; relationships: unknown[] },
      ) => {
        for (const entity of input.entities) {
          // entity.key is e.g. "communications:participant:email:foo@example.com"
          const parts = entity.key.split(':');
          // ["communications", "participant", kind, valueNormalized...] — value
          // may itself contain colons (none of our normalized forms do, but be
          // defensive) so rejoin everything past index 2.
          const kind = parts[2];
          const valueNormalized = parts.slice(3).join(':');
          const composite = `${kind}:${valueNormalized}`;
          if (toAssign[composite]) {
            indexedByComposite.set(composite, toAssign[composite]);
          }
        }

        return {
          entitiesProcessed: input.entities.length,
          relationshipsProcessed: 0,
          errors: [] as string[],
        };
      },
    ),
  };
}

function makeDataSource() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  return {
    dataSource: {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });

        return [];
      }),
    },
    calls,
  };
}

function makeListener(
  comm: FakeCommunication | null,
  initialIndex: Record<string, string>,
  ingestAssigns: Record<string, string> = {},
) {
  const communicationService = makeCommunicationService(comm);
  const identifierService = makeIdentifierService(initialIndex);
  const graphIngestService = makeIngestService(identifierService.indexedByComposite, ingestAssigns);
  const ds = makeDataSource();
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new CommunicationParticipantLinkListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    communicationService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    identifierService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphIngestService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ds.dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { listener, communicationService, identifierService, graphIngestService, ds };
}

describe('CommunicationParticipantLinkListener.handleCreated', () => {
  it('writes from + to ids and binds the full PK (time, user_id, id) on the UPDATE', async () => {
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: null,
      toEntityIds: null,
      participantsMetadata: {
        from: 'sender@example.com',
        to: ['unknown@example.com'],
      },
    };

    const { listener, graphIngestService, ds } = makeListener(
      comm,
      // `from` already in the index — reused, no stub created.
      { 'email:sender@example.com': EXISTING_FROM },
      // `to` lands a new entity via ingest.
      { 'email:unknown@example.com': NEW_TO_1 },
    );

    await listener.handleCreated({ communicationId: COMM_ID });

    // Only the unknown `to` triggers stub creation.
    expect(graphIngestService.ingest).toHaveBeenCalledTimes(1);
    const ingestPayload = graphIngestService.ingest.mock.calls[0][1];
    expect(ingestPayload.entities).toHaveLength(1);
    expect(ingestPayload.entities[0].key).toBe('communications:participant:email:unknown@example.com');

    // UPDATE binds the full hypertable PK + chunk-pruning `time` partition col.
    expect(ds.calls).toHaveLength(1);
    const { sql, params } = ds.calls[0];
    expect(sql).toContain('UPDATE ci.communications');
    expect(sql).toContain('user_id = $1');
    expect(sql).toContain('id = $2');
    expect(sql).toContain('time = $5');
    expect(params).toEqual([USER, COMM_ID, EXISTING_FROM, [NEW_TO_1], COMM_TIME]);
  });

  it('skips stub creation entirely when every identifier is already in the index', async () => {
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: null,
      toEntityIds: null,
      participantsMetadata: { from: 'sender@example.com', to: ['known@example.com'] },
    };

    const { listener, graphIngestService, ds } = makeListener(comm, {
      'email:sender@example.com': EXISTING_FROM,
      'email:known@example.com': NEW_TO_1,
    });

    await listener.handleCreated({ communicationId: COMM_ID });

    expect(graphIngestService.ingest).not.toHaveBeenCalled();
    expect(ds.calls).toHaveLength(1);
    expect(ds.calls[0].params).toEqual([USER, COMM_ID, EXISTING_FROM, [NEW_TO_1], COMM_TIME]);
  });

  it('is a no-op when both link sides are already populated', async () => {
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: EXISTING_FROM,
      toEntityIds: [NEW_TO_1],
      participantsMetadata: { from: 'sender@example.com', to: ['known@example.com'] },
    };

    const { listener, identifierService, graphIngestService, ds } = makeListener(comm, {});

    await listener.handleCreated({ communicationId: COMM_ID });

    expect(identifierService.findEntityIdsByIdentifiers).not.toHaveBeenCalled();
    expect(graphIngestService.ingest).not.toHaveBeenCalled();
    expect(ds.calls).toHaveLength(0);
  });

  it('seeds stub Person entities for cc/bcc but does not write them back to any link column', async () => {
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: null,
      toEntityIds: null,
      participantsMetadata: {
        // `from` and `to` are absent, so the only identifiers come from cc/bcc;
        // those should produce stubs but nothing to write back (no fromId, no toIds).
        cc: 'cc@example.com',
        bcc: ['bcc@example.com'],
      },
    };

    const { listener, graphIngestService, ds } = makeListener(comm, {});

    await listener.handleCreated({ communicationId: COMM_ID });

    expect(graphIngestService.ingest).toHaveBeenCalledTimes(1);
    const ingestPayload = graphIngestService.ingest.mock.calls[0][1];
    const keys = ingestPayload.entities.map((e: { key: string }) => e.key).sort();
    expect(keys).toEqual([
      'communications:participant:email:bcc@example.com',
      'communications:participant:email:cc@example.com',
    ]);

    // Nothing resolved for from/to so the listener short-circuits before UPDATE.
    expect(ds.calls).toHaveLength(0);
  });

  it('writes nothing when participants_metadata yields no resolvable identifiers', async () => {
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: null,
      toEntityIds: null,
      participantsMetadata: { from: '   ', to: [] },
    };

    const { listener, graphIngestService, ds } = makeListener(comm, {});

    await listener.handleCreated({ communicationId: COMM_ID });

    expect(graphIngestService.ingest).not.toHaveBeenCalled();
    expect(ds.calls).toHaveLength(0);
  });

  it('only fills the missing side (from already set -> resolves to only)', async () => {
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: EXISTING_FROM,
      toEntityIds: null,
      participantsMetadata: {
        from: 'sender@example.com',
        to: ['unknown@example.com'],
      },
    };

    const { listener, graphIngestService, ds } = makeListener(
      comm,
      {},
      { 'email:unknown@example.com': NEW_TO_1 },
    );

    await listener.handleCreated({ communicationId: COMM_ID });

    // `from` was already set, so it must NOT be classified or ingested.
    const ingestPayload = graphIngestService.ingest.mock.calls[0][1];
    const keys = ingestPayload.entities.map((e: { key: string }) => e.key);
    expect(keys).toEqual(['communications:participant:email:unknown@example.com']);

    expect(ds.calls).toHaveLength(1);
    // fromId is null (already set, listener won't overwrite); toIds is [NEW_TO_1].
    expect(ds.calls[0].params).toEqual([USER, COMM_ID, null, [NEW_TO_1], COMM_TIME]);
  });

  it('skips when the communication row is missing', async () => {
    const { listener, ds, graphIngestService } = makeListener(null, {});

    await listener.handleCreated({ communicationId: COMM_ID });

    expect(ds.calls).toHaveLength(0);
    expect(graphIngestService.ingest).not.toHaveBeenCalled();
  });

  it('skips when the communication has no owner', async () => {
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: null,
      fromEntityId: null,
      toEntityIds: null,
      participantsMetadata: { from: 'sender@example.com' },
    };

    const { listener, ds, graphIngestService } = makeListener(comm, {});

    await listener.handleCreated({ communicationId: COMM_ID });

    expect(ds.calls).toHaveLength(0);
    expect(graphIngestService.ingest).not.toHaveBeenCalled();
  });
});
