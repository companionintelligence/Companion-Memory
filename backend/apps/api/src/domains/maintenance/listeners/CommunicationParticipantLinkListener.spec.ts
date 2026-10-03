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

function makeIdentifierService(initial: Record<string, string>, forgotten: string[] = []) {
  // The service performs two lookups per run (pre-ingest + post-ingest). The
  // post-ingest lookup must reflect any keys the ingest mock landed, so we
  // expose the map for tests to mutate.
  const indexedByComposite = new Map(Object.entries(initial));
  const listed = new Set(forgotten);

  return {
    indexedByComposite,
    // `ci.forgotten_identifiers`: the identifiers of people the owner asked memory.forget to erase.
    findForgottenIdentifiers: jest.fn(
      async (_userId: string, keys: Array<{ kind: string; valueNormalized: string }>) =>
        new Set(
          keys
            .map((key) => `${key.kind}:${key.valueNormalized}`)
            .filter((composite) => listed.has(composite)),
        ),
    ),
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
    repointToEntity: jest.fn(async () => null),
    claimForSelf: jest.fn(async () => 0),
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
  // Statement order across the write's transaction, including the re-open.
  const order: string[] = [];
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });

    if (sql.includes('UPDATE ci.communications')) {
      order.push('update');
    }

    return [];
  });
  const managers: Array<{ query: typeof query }> = [];
  const transaction = jest.fn(async (cb: (em: { query: typeof query }) => Promise<unknown>) => {
    const em = { query };
    managers.push(em);
    order.push('begin');
    const result = await cb(em);
    order.push('commit');

    return result;
  });

  return { dataSource: { query, transaction }, calls, order, managers };
}

/** `EDGE_PROJECTION_REOPENER` as the lazily-resolving ModuleRef returns it. */
function makeReopener(order?: string[]) {
  const reopener = {
    reopen: jest.fn(async (_source: string, ids: readonly string[], _manager: unknown) => {
      order?.push('reopen');

      return ids.length;
    }),
  };

  return { reopener, moduleRef: { get: jest.fn(() => reopener) } };
}

function makeListener(
  comm: FakeCommunication | null,
  initialIndex: Record<string, string>,
  ingestAssigns: Record<string, string> = {},
  forgotten: string[] = [],
) {
  const communicationService = makeCommunicationService(comm);
  const identifierService = makeIdentifierService(initialIndex, forgotten);
  const graphIngestService = makeIngestService(identifierService.indexedByComposite, ingestAssigns);
  const ds = makeDataSource();
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const { reopener, moduleRef } = makeReopener(ds.order);

  const listener = new CommunicationParticipantLinkListener(
    communicationService as never,
    identifierService as never,
    graphIngestService as never,
    { getTrustMode: jest.fn(async () => 'balanced') } as never,
    ds.dataSource as never,
    logger as never,
    moduleRef as never,
  );

  return { listener, communicationService, identifierService, graphIngestService, ds, reopener };
}

function updateCalls(ds: ReturnType<typeof makeDataSource>) {
  return ds.calls.filter((call) => call.sql.includes('UPDATE ci.communications'));
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
    const updates = updateCalls(ds);
    expect(updates).toHaveLength(1);
    const { sql, params } = updates[0];
    expect(sql).toContain('UPDATE ci.communications');
    expect(sql).toContain('user_id = $1');
    expect(sql).toContain('id = $2');
    expect(sql).toContain('time = $5');
    expect(params).toEqual([USER, COMM_ID, EXISTING_FROM, [NEW_TO_1], COMM_TIME]);
  });

  it("re-opens the edge leg's decision for the message in the UPDATE's own transaction", async () => {
    // Created with an attachment, a message is a candidate for
    // promote.edge_communication before this job links anyone; if the leg got
    // there first, only a re-open brings its SENT / RECEIVED edges.
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: null,
      toEntityIds: null,
      participantsMetadata: { from: 'sender@example.com' },
    };

    const { listener, ds, reopener } = makeListener(comm, { 'email:sender@example.com': EXISTING_FROM });

    await listener.handleCreated({ communicationId: COMM_ID });

    expect(reopener.reopen).toHaveBeenCalledTimes(1);
    expect(reopener.reopen).toHaveBeenCalledWith('communications', [COMM_ID], ds.managers[0]);
    expect(ds.order).toEqual(['begin', 'update', 'reopen', 'commit']);
  });

  it('writes nothing, and re-opens nothing, when no re-opener is bound', async () => {
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: null,
      toEntityIds: null,
      participantsMetadata: { from: 'sender@example.com' },
    };
    const communicationService = makeCommunicationService(comm);
    const identifierService = makeIdentifierService({ 'email:sender@example.com': EXISTING_FROM });
    const ds = makeDataSource();
    const listener = new CommunicationParticipantLinkListener(
      communicationService as never,
      identifierService as never,
      makeIngestService(identifierService.indexedByComposite) as never,
      { getTrustMode: jest.fn(async () => 'balanced') } as never,
      ds.dataSource as never,
      { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    );

    // Thrown so the people-linking job fails and retries, rather than linking
    // a message the edge leg may already have decided.
    await expect(listener.handleCreated({ communicationId: COMM_ID })).rejects.toThrow(
      /EDGE_PROJECTION_REOPENER/,
    );
    expect(updateCalls(ds)).toHaveLength(0);
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
    const updates = updateCalls(ds);
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual([USER, COMM_ID, EXISTING_FROM, [NEW_TO_1], COMM_TIME]);
  });

  it('writes nothing when the sender is set and every recipient is already linked', async () => {
    // A populated recipient list is no longer taken as "done" — the listener
    // still resolves every name — but when the column already carries each
    // one there is nothing to add, and no UPDATE is issued.
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: EXISTING_FROM,
      toEntityIds: [NEW_TO_1],
      participantsMetadata: { from: 'sender@example.com', to: ['known@example.com'] },
    };
    const { listener, graphIngestService, ds } = makeListener(comm, {
      'email:sender@example.com': EXISTING_FROM,
      'email:known@example.com': NEW_TO_1,
    });

    await listener.handleCreated({ communicationId: COMM_ID });

    expect(graphIngestService.ingest).not.toHaveBeenCalled();
    expect(updateCalls(ds)).toHaveLength(0);
  });

  it('MERGES a newly resolved recipient into a partial list instead of skipping the row', async () => {
    // The regression this guards: an inbound group message whose list held
    // only the owner (the one name the index knew at the time) was treated as
    // linked, so the other recipient never landed on it.
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: EXISTING_FROM,
      toEntityIds: [EXISTING_FROM],
      participantsMetadata: { from: 'sender@example.com', to: ['me@example.com', 'brianne@example.com'] },
    };
    const { listener, ds } = makeListener(comm, {
      'email:sender@example.com': EXISTING_FROM,
      'email:me@example.com': EXISTING_FROM,
      'email:brianne@example.com': NEW_TO_1,
    });

    await listener.handleCreated({ communicationId: COMM_ID });

    const updates = updateCalls(ds);

    expect(updates).toHaveLength(1);
    // Only the ids the column lacks are bound; the SQL appends them after the
    // existing ones and never replaces the list.
    expect(updates[0].params).toEqual([USER, COMM_ID, null, [NEW_TO_1], COMM_TIME]);
    expect(updates[0].sql.replace(/\s+/g, ' ')).toMatch(
      /WHEN \$4::uuid\[\] IS NULL THEN to_entity_ids ELSE ARRAY\(/,
    );
    expect(updates[0].sql).toMatch(/WITH ORDINALITY/);
    expect(updates[0].sql).not.toMatch(/cardinality\(to_entity_ids\) = 0/);
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
    expect(updateCalls(ds)).toHaveLength(0);
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
    expect(updateCalls(ds)).toHaveLength(0);
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

    const updates = updateCalls(ds);
    expect(updates).toHaveLength(1);
    // fromId is null (already set, listener won't overwrite); toIds is [NEW_TO_1].
    expect(updates[0].params).toEqual([USER, COMM_ID, null, [NEW_TO_1], COMM_TIME]);
  });

  it('skips when the communication row is missing', async () => {
    const { listener, ds, graphIngestService } = makeListener(null, {});

    await listener.handleCreated({ communicationId: COMM_ID });

    expect(updateCalls(ds)).toHaveLength(0);
    expect(graphIngestService.ingest).not.toHaveBeenCalled();
  });

  it('logs a warning when readSelfIdentity genuinely fails, and still links via the empty-identity fallback', async () => {
    const comm: FakeCommunication = {
      id: COMM_ID,
      time: COMM_TIME,
      userId: USER,
      fromEntityId: null,
      toEntityIds: null,
      participantsMetadata: { from: 'sender@example.com' },
    };

    const communicationService = makeCommunicationService(comm);
    const identifierService = makeIdentifierService({ 'email:sender@example.com': EXISTING_FROM });
    const graphIngestService = makeIngestService(identifierService.indexedByComposite);
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    // The self-identity query is the only one carrying UNION ALL (see self.ts);
    // every other query used by the listener (resolveSelfEntityId, the UPDATE)
    // must keep succeeding so the failure is isolated to readSelfIdentity.
    const query = jest.fn(async (sql: string, _params: unknown[]) => {
      if (sql.includes('UNION ALL')) {
        throw new Error('connection terminated unexpectedly');
      }

      return [];
    });
    const dataSource = {
      query,
      transaction: jest.fn(async (cb: (em: { query: typeof query }) => Promise<unknown>) => cb({ query })),
    };

    const listener = new CommunicationParticipantLinkListener(
      communicationService as never,
      identifierService as never,
      graphIngestService as never,
      { getTrustMode: jest.fn(async () => 'balanced') } as never,
      dataSource as never,
      logger as never,
      makeReopener().moduleRef as never,
    );

    await listener.handleCreated({ communicationId: COMM_ID });

    expect(logger.warn).toHaveBeenCalledWith(
      'Self-identity lookup failed; participants will not be self-collated',
      expect.objectContaining({
        communicationId: COMM_ID,
        userId: USER,
        error: 'connection terminated unexpectedly',
      }),
    );

    // The fallback (empty identity) must not stop the row from linking.
    const updates = dataSource.query.mock.calls.filter(([sql]) => sql.includes('UPDATE ci.communications'));
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([USER, COMM_ID, EXISTING_FROM, null, COMM_TIME]);
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

    expect(updateCalls(ds)).toHaveLength(0);
    expect(graphIngestService.ingest).not.toHaveBeenCalled();
  });

  describe('a person the owner asked memory.forget to erase', () => {
    const FORGOTTEN = 'email:dana@example.com';

    it('is not created again by a new message from them, and everyone else on it is still linked', async () => {
      const comm: FakeCommunication = {
        id: COMM_ID,
        time: COMM_TIME,
        userId: USER,
        fromEntityId: null,
        toEntityIds: null,
        participantsMetadata: { from: 'Dana Quill <dana@example.com>', to: ['unknown@example.com'] },
      };

      const { listener, graphIngestService, ds } = makeListener(
        comm,
        {},
        { 'email:unknown@example.com': NEW_TO_1 },
        [FORGOTTEN],
      );

      await listener.handleCreated({ communicationId: COMM_ID });

      // Only the stranger is minted. The sender is left unresolved: nobody is there to resolve to.
      expect(graphIngestService.ingest).toHaveBeenCalledTimes(1);
      expect(graphIngestService.ingest.mock.calls[0][1].entities.map((e: { key: string }) => e.key)).toEqual([
        'communications:participant:email:unknown@example.com',
      ]);

      const updates = updateCalls(ds);

      expect(updates).toHaveLength(1);
      expect(updates[0].params).toEqual([USER, COMM_ID, null, [NEW_TO_1], COMM_TIME]);
    });

    it('is created again by a new message from them when the owner did not ask for them to be forgotten', async () => {
      const comm: FakeCommunication = {
        id: COMM_ID,
        time: COMM_TIME,
        userId: USER,
        fromEntityId: null,
        toEntityIds: null,
        participantsMetadata: { from: 'Dana Quill <dana@example.com>' },
      };

      const { listener, graphIngestService } = makeListener(
        comm,
        {},
        { 'email:dana@example.com': NEW_TO_1 },
        [],
      );

      await listener.handleCreated({ communicationId: COMM_ID });

      expect(graphIngestService.ingest).toHaveBeenCalledTimes(1);
    });

    it('leaves the message alone when they are the only person on it', async () => {
      const comm: FakeCommunication = {
        id: COMM_ID,
        time: COMM_TIME,
        userId: USER,
        fromEntityId: null,
        toEntityIds: null,
        participantsMetadata: { from: 'dana@example.com' },
      };

      const { listener, graphIngestService, ds } = makeListener(comm, {}, {}, [FORGOTTEN]);

      await listener.handleCreated({ communicationId: COMM_ID });

      expect(graphIngestService.ingest).not.toHaveBeenCalled();
      expect(updateCalls(ds)).toHaveLength(0);
    });

    it('asks about every identifier on the message in one query, for the owner whose mail it is', async () => {
      const comm: FakeCommunication = {
        id: COMM_ID,
        time: COMM_TIME,
        userId: USER,
        fromEntityId: null,
        toEntityIds: null,
        participantsMetadata: { from: 'a@example.com', to: ['b@example.com'], cc: 'c@example.com' },
      };

      const { listener, identifierService } = makeListener(comm, {});

      await listener.handleCreated({ communicationId: COMM_ID });

      expect(identifierService.findForgottenIdentifiers).toHaveBeenCalledTimes(1);

      const [userArg, keysArg] = identifierService.findForgottenIdentifiers.mock.calls[0];

      expect(userArg).toBe(USER);
      expect(keysArg.map((key) => `${key.kind}:${key.valueNormalized}`).sort()).toEqual([
        'email:a@example.com',
        'email:b@example.com',
        'email:c@example.com',
      ]);
    });
  });
});
