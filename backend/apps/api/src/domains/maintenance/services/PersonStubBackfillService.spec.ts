import { PersonStubBackfillService } from './PersonStubBackfillService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const EXISTING_ENTITY = '00000000-0000-0000-0000-0000000000b1';

const END = new Date('2026-01-08T00:00:00.000Z');
const START = new Date('2026-01-01T00:00:00.000Z');

interface FakeRow {
  id: string;
  time: Date;
  participants_metadata: Record<string, unknown> | null;
}

function makeDataSource(rows: FakeRow[]) {
  let selectServed = false;

  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM ci.users') && sql.includes('entity_id')) {
      return [{ entity_id: null }];
    }

    if (sql.includes('FROM ci.users u') || sql.includes('is_self')) {
      return [];
    }

    if (sql.includes('FROM ci.communications')) {
      if (!selectServed) {
        selectServed = true;

        return rows;
      }

      return [];
    }

    return [];
  });

  return { dataSource: { query }, query };
}

function makeIdentifierService(existing: Record<string, string>, forgotten: string[] = []) {
  const listed = new Set(forgotten);

  return {
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
          if (existing[composite]) {
            out.set(composite, existing[composite]);
          }
        }

        return out;
      },
    ),
    repointToEntity: jest.fn(async () => null),
    claimForSelf: jest.fn(async () => 0),
  };
}

interface IngestEntityCapture {
  key: string;
  entityType: string;
  name?: string | null;
  sourceSystem: string;
  properties?: Record<string, unknown> | null;
}

function makeIngestService() {
  return {
    ingest: jest.fn(
      async (
        _context: { userId: string },
        input: { entities: IngestEntityCapture[]; relationships: unknown[] },
      ) => ({
        entitiesProcessed: input.entities.length,
        relationshipsProcessed: 0,
        errors: [] as string[],
      }),
    ),
  };
}

function makeService(rows: FakeRow[], existing: Record<string, string>, forgotten: string[] = []) {
  const ds = makeDataSource(rows);
  const ids = makeIdentifierService(existing, forgotten);
  const ingest = makeIngestService();
  const personalization = {
    getTrustMode: jest.fn(async () => 'balanced' as const),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new PersonStubBackfillService(
    ds.dataSource as never,
    ingest as never,
    ids as never,
    personalization as never,
    logger as never,
  );

  return { service, ds, ids, ingest, personalization };
}

describe('PersonStubBackfillService.backfill', () => {
  it('extracts a Person + identifier for every new participant across from/to/cc/bcc', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        participants_metadata: {
          from: 'Alice <alice@Example.com>',
          to: ['+1 (415) 555-0100'],
          cc: 'cc@example.com',
          bcc: ['bcc@example.com'],
        },
      },
    ];

    const { service, ingest } = makeService(rows, {});

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.examined).toBe(1);
    expect(result.identifiersSeen).toBe(4);
    expect(result.identifiersExisting).toBe(0);
    expect(result.peopleCreated).toBe(4);

    expect(ingest.ingest).toHaveBeenCalledTimes(1);
    const [, payload] = ingest.ingest.mock.calls[0];
    expect(payload.entities).toHaveLength(4);

    const emails: string[] = [];
    const phones: string[] = [];
    for (const entity of payload.entities) {
      const props = entity.properties ?? {};
      if (Array.isArray(props.emails)) {
        emails.push(...(props.emails as string[]));
      }

      if (Array.isArray(props.phones)) {
        phones.push(...(props.phones as string[]));
      }
    }

    // 'Alice <alice@Example.com>' normalizes to the bare, lowercased address —
    // the display name is stripped so the same mailbox does not fragment across
    // Person entities (see normalizeEmail).
    expect(emails.sort()).toEqual(['alice@example.com', 'bcc@example.com', 'cc@example.com'].sort());
    expect(phones).toEqual(['4155550100']);
    expect(payload.entities.every((e) => e.entityType === 'Person')).toBe(true);
  });

  it('skips identifiers that already have a Person entity', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        participants_metadata: {
          from: 'sender@example.com',
          to: ['new@example.com'],
        },
      },
    ];

    const { service, ingest } = makeService(rows, {
      'email:sender@example.com': EXISTING_ENTITY,
    });

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.identifiersSeen).toBe(2);
    expect(result.identifiersExisting).toBe(1);
    expect(result.peopleCreated).toBe(1);

    expect(ingest.ingest).toHaveBeenCalledTimes(1);
    const [, payload] = ingest.ingest.mock.calls[0];
    expect(payload.entities).toHaveLength(1);
    expect(payload.entities[0].properties?.emails).toEqual(['new@example.com']);
  });

  it('dedups identifiers across rows so the same email is ingested once', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        participants_metadata: { from: 'Repeat@Example.com', to: [] },
      },
      {
        id: 'row-2',
        time: new Date('2026-01-07T00:00:00.000Z'),
        participants_metadata: { from: 'repeat@example.com', to: ['repeat@EXAMPLE.com'] },
      },
    ];

    const { service, ingest } = makeService(rows, {});

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.examined).toBe(2);
    expect(result.identifiersSeen).toBe(1);
    expect(result.peopleCreated).toBe(1);

    const [, payload] = ingest.ingest.mock.calls[0];
    expect(payload.entities).toHaveLength(1);
    expect(payload.entities[0].properties?.emails).toEqual(['repeat@example.com']);
  });

  it('creates name-kind stubs for display-name-only participants (Messenger)', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        participants_metadata: {
          from: 'Brian Paul',
          to: ['Gabrielle DePesa', 'brian  PAUL'], // dupe of `from` after normalization
        },
      },
    ];

    const { service, ingest } = makeService(rows, {});

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.identifiersSeen).toBe(2);
    expect(result.peopleCreated).toBe(2);

    const [, payload] = ingest.ingest.mock.calls[0];
    expect(payload.entities).toHaveLength(2);
    const brian = payload.entities.find((e) => e.name === 'Brian Paul');
    expect(brian?.properties?.names).toEqual(['brian paul']);
    expect(brian?.key).toBe('communications:participant:name:brian paul');
    // Structured name parts, middle omitted for a two-token name.
    expect(brian?.properties?.first_name).toBe('Brian');
    expect(brian?.properties?.last_name).toBe('Paul');
    expect(brian?.properties).not.toHaveProperty('middle_name');
    const gabrielle = payload.entities.find((e) => e.name === 'Gabrielle DePesa');
    expect(gabrielle?.properties?.names).toEqual(['gabrielle depesa']);
  });

  it('drops empty / whitespace participants without crashing', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        participants_metadata: { from: '   ', to: ['', '   ', null as unknown as string] },
      },
    ];

    const { service, ingest } = makeService(rows, {});

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.identifiersSeen).toBe(0);
    expect(result.peopleCreated).toBe(0);
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('skips entirely when bounds are inverted', async () => {
    const { service, ds, ingest, ids } = makeService([], {});

    const result = await service.backfill(USER, { startTime: END, endTime: START });

    expect(result.range).toBeNull();
    expect(ds.query).not.toHaveBeenCalled();
    expect(ingest.ingest).not.toHaveBeenCalled();
    expect(ids.findEntityIdsByIdentifiers).not.toHaveBeenCalled();
  });

  it('derives bounds from the data when no range is supplied', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        participants_metadata: { from: 'sender@example.com' },
      },
    ];

    let boundsServed = false;
    let selectServed = false;
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('MIN(time)')) {
        boundsServed = true;

        return [
          {
            min_time: new Date('2026-01-07T00:00:00.000Z'),
            max_time: new Date('2026-01-07T00:00:00.000Z'),
          },
        ];
      }

      if (sql.includes('FROM ci.communications')) {
        if (!selectServed) {
          selectServed = true;

          return rows;
        }

        return [];
      }

      return [];
    });

    const ids = makeIdentifierService({});
    const ingest = makeIngestService();
    const personalization = {
      getTrustMode: jest.fn(async () => 'balanced' as const),
    };
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const service = new PersonStubBackfillService(
      { query } as never,
      ingest as never,
      ids as never,
      personalization as never,
      logger as never,
    );

    const result = await service.backfill(USER);

    expect(boundsServed).toBe(true);
    expect(result.range).not.toBeNull();
    expect(result.peopleCreated).toBe(1);
  });

  it('returns an empty result when there are no candidate rows at all', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('MIN(time)')) {
        return [{ min_time: null, max_time: null }];
      }

      return [];
    });
    const ids = makeIdentifierService({});
    const ingest = makeIngestService();
    const personalization = {
      getTrustMode: jest.fn(async () => 'balanced' as const),
    };
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const service = new PersonStubBackfillService(
      { query } as never,
      ingest as never,
      ids as never,
      personalization as never,
      logger as never,
    );

    const result = await service.backfill(USER);

    expect(result.range).toBeNull();
    expect(result.windows).toBe(0);
    expect(result.identifiersForgotten).toBe(0);
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('uses the raw participant string as the stub display name', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        participants_metadata: { from: '  alice@example.com  ' },
      },
    ];

    const { service, ingest } = makeService(rows, {});

    await service.backfill(USER, { startTime: START, endTime: END });

    const [, payload] = ingest.ingest.mock.calls[0];
    expect(payload.entities[0].name).toBe('alice@example.com');
  });

  it('stamps every stub with sourceSystem = communications:participant', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        participants_metadata: { from: 'a@example.com', to: ['+14155550100'] },
      },
    ];

    const { service, ingest } = makeService(rows, {});

    await service.backfill(USER, { startTime: START, endTime: END });

    const [, payload] = ingest.ingest.mock.calls[0];
    for (const entity of payload.entities) {
      expect(entity.sourceSystem).toBe('communications:participant');
    }
  });

  it('claims owner email onto self instead of minting a stub when self exists', async () => {
    const SELF = '00000000-0000-0000-0000-0000000000c1';
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        participants_metadata: { from: 'owner@example.com', to: ['friend@example.com'] },
      },
    ];

    const ds = makeDataSource(rows);
    let selectServed = false;
    ds.query.mockImplementation((async (sql: string) => {
      if (sql.includes('SELECT entity_id FROM ci.users')) {
        return [{ entity_id: SELF }];
      }

      if (sql.includes('FROM ci.users u') || sql.includes('is_self')) {
        return [
          { name: 'Owner', email: 'owner@example.com', phones_json: null },
          { name: 'Owner', email: null, phones_json: [] },
        ];
      }

      if (sql.includes('FROM ci.communications')) {
        if (!selectServed) {
          selectServed = true;

          return rows;
        }

        return [];
      }

      return [];
    }) as typeof ds.query);

    const ids = makeIdentifierService({});
    const ingest = makeIngestService();
    const personalization = {
      getTrustMode: jest.fn(async () => 'balanced' as const),
    };
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const service = new PersonStubBackfillService(
      ds.dataSource as never,
      ingest as never,
      ids as never,
      personalization as never,
      logger as never,
    );

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(ids.repointToEntity).toHaveBeenCalledWith(
      USER,
      SELF,
      'email',
      'owner@example.com',
      'self_collation',
    );
    expect(result.peopleCreated).toBe(1);
    const [, payload] = ingest.ingest.mock.calls[0];
    expect(payload.entities).toHaveLength(1);
    expect(payload.entities[0].properties).toMatchObject({ emails: ['friend@example.com'] });
  });

  describe('binding a participant to the owner', () => {
    // Invented throughout: the owner's name, account email and phone.
    const SELF = '00000000-0000-0000-0000-0000000000f1';

    function makeOwnerService(rows: FakeRow[], trustMode: 'cautious' | 'balanced' | 'hands_off') {
      let selectServed = false;
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('SELECT entity_id FROM ci.users')) {
          return [{ entity_id: SELF }];
        }

        if (sql.includes('FROM ci.users u') || sql.includes('is_self')) {
          return [
            { name: 'Avery Quinn', email: 'avery@owner.example', phones_json: null },
            { name: 'Avery Quinn', email: null, phones_json: ['+1 415-555-0100'] },
          ];
        }

        if (sql.includes('FROM ci.communications')) {
          if (!selectServed) {
            selectServed = true;

            return rows;
          }

          return [];
        }

        return [];
      });

      const ids = makeIdentifierService({});
      const ingest = makeIngestService();
      const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const service = new PersonStubBackfillService(
        { query } as never,
        ingest as never,
        ids as never,
        { getTrustMode: jest.fn(async () => trustMode) } as never,
        logger as never,
      );

      return { service, ids, ingest };
    }

    const row = (participants: Record<string, unknown>): FakeRow => ({
      id: 'row-1',
      time: new Date('2026-01-07T00:00:00.000Z'),
      participants_metadata: participants,
    });

    it.each(['cautious', 'balanced', 'hands_off'] as const)(
      "mints a contact for a stranger writing under the owner's name instead of filing the address as the owner's (%s)",
      async (trustMode) => {
        const { service, ids, ingest } = makeOwnerService(
          [row({ from: '"Avery Quinn" <someone@other.example>' })],
          trustMode,
        );

        await service.backfill(USER, { startTime: START, endTime: END });

        expect(ids.repointToEntity).not.toHaveBeenCalled();
        expect(ids.claimForSelf).not.toHaveBeenCalled();
        const [, payload] = ingest.ingest.mock.calls[0];
        expect(payload.entities.map((entity) => entity.properties)).toEqual([
          expect.objectContaining({ emails: ['someone@other.example'] }),
        ]);
      },
    );

    it("does not read the owner's phone digits out of a display name", async () => {
      const { service, ids, ingest } = makeOwnerService(
        [row({ from: '"Call 415 555 0100 today" <promo@other.example>', to: ['Support 415 555 0100'] })],
        'cautious',
      );

      await service.backfill(USER, { startTime: START, endTime: END });

      expect(ids.repointToEntity).not.toHaveBeenCalled();
      expect(ids.claimForSelf).not.toHaveBeenCalled();
      const [, payload] = ingest.ingest.mock.calls[0];
      expect(payload.entities.map((entity) => entity.properties)).toEqual([
        expect.objectContaining({ emails: ['promo@other.example'] }),
        expect.objectContaining({ names: ['support 415 555 0100'] }),
      ]);
    });

    it("still files the owner's own number as the owner's", async () => {
      const { service, ids, ingest } = makeOwnerService([row({ from: '+1 (415) 555-0100' })], 'cautious');

      await service.backfill(USER, { startTime: START, endTime: END });

      expect(ids.repointToEntity).toHaveBeenCalledWith(
        USER,
        SELF,
        'phone',
        '+1 (415) 555-0100',
        'self_collation',
      );
      expect(ingest.ingest).not.toHaveBeenCalled();
    });
  });

  describe('a person the owner asked memory.forget to erase', () => {
    const FORGOTTEN = 'email:dana@example.com';

    it('is not created again from the mail that still names them, and everyone else on it still is', async () => {
      const rows: FakeRow[] = [
        {
          id: 'row-1',
          time: new Date('2026-01-07T00:00:00.000Z'),
          participants_metadata: { from: 'Dana Quill <dana@example.com>', to: ['new@example.com'] },
        },
      ];

      const { service, ingest } = makeService(rows, {}, [FORGOTTEN]);

      const result = await service.backfill(USER, { startTime: START, endTime: END });

      expect(result.identifiersSeen).toBe(2);
      expect(result.identifiersForgotten).toBe(1);
      expect(result.peopleCreated).toBe(1);

      const [, payload] = ingest.ingest.mock.calls[0];

      expect(payload.entities).toHaveLength(1);
      expect(payload.entities[0].properties?.emails).toEqual(['new@example.com']);
    });

    it('is created again when the owner did not ask for them to be forgotten', async () => {
      const rows: FakeRow[] = [
        {
          id: 'row-1',
          time: new Date('2026-01-07T00:00:00.000Z'),
          participants_metadata: { from: 'Dana Quill <dana@example.com>', to: ['new@example.com'] },
        },
      ];

      const { service, ingest } = makeService(rows, {}, []);

      const result = await service.backfill(USER, { startTime: START, endTime: END });

      expect(result.identifiersForgotten).toBe(0);
      expect(result.peopleCreated).toBe(2);
      expect(ingest.ingest.mock.calls[0][1].entities).toHaveLength(2);
    });

    it('leaves nothing to ingest when every participant on the page is forgotten', async () => {
      const rows: FakeRow[] = [
        {
          id: 'row-1',
          time: new Date('2026-01-07T00:00:00.000Z'),
          participants_metadata: { from: 'dana@example.com', to: ['dana@example.com'] },
        },
      ];

      const { service, ingest } = makeService(rows, {}, [FORGOTTEN]);

      const result = await service.backfill(USER, { startTime: START, endTime: END });

      expect(result).toMatchObject({
        identifiersSeen: 1,
        identifiersForgotten: 1,
        peopleCreated: 0,
        errors: [],
      });
      expect(ingest.ingest).not.toHaveBeenCalled();
    });

    it('asks about every identifier on a page in one query, for the owner whose mail it is', async () => {
      const rows: FakeRow[] = [
        {
          id: 'row-1',
          time: new Date('2026-01-07T00:00:00.000Z'),
          participants_metadata: {
            from: 'a@example.com',
            to: ['b@example.com', '+1 (415) 555-0100'],
            cc: 'c@example.com',
          },
        },
      ];

      const { service, ids } = makeService(rows, {}, []);

      await service.backfill(USER, { startTime: START, endTime: END });

      expect(ids.findForgottenIdentifiers).toHaveBeenCalledTimes(1);

      const [userArg, keysArg] = ids.findForgottenIdentifiers.mock.calls[0];

      expect(userArg).toBe(USER);
      expect(keysArg.map((key) => `${key.kind}:${key.valueNormalized}`).sort()).toEqual(
        ['email:a@example.com', 'email:b@example.com', 'email:c@example.com', 'phone:4155550100'].sort(),
      );
    });

    it('counts an identifier the index already covers as existing, and does not ask what to do with it twice', async () => {
      const rows: FakeRow[] = [
        {
          id: 'row-1',
          time: new Date('2026-01-07T00:00:00.000Z'),
          participants_metadata: { from: 'dana@example.com' },
        },
      ];

      // Somebody holds the address again (a contact typed in after the forget): the index wins.
      const { service, ingest } = makeService(rows, { [FORGOTTEN]: EXISTING_ENTITY }, [FORGOTTEN]);

      const result = await service.backfill(USER, { startTime: START, endTime: END });

      expect(result).toMatchObject({ identifiersExisting: 1, identifiersForgotten: 0, peopleCreated: 0 });
      expect(ingest.ingest).not.toHaveBeenCalled();
    });

    it('asks nothing when there is nobody to ask about', async () => {
      const { service, ids } = makeService([], {}, [FORGOTTEN]);

      await service.backfill(USER, { startTime: START, endTime: END });

      expect(ids.findForgottenIdentifiers).not.toHaveBeenCalled();
    });
  });
});
