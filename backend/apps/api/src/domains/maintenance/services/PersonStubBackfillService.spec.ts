import { PersonStubBackfillService } from './PersonStubBackfillService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const EXISTING_ENTITY = '00000000-0000-0000-0000-0000000000b1';
const NEW_ENTITY = '00000000-0000-0000-0000-0000000000b2';

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

function makeIdentifierService(existing: Record<string, string>) {
  return {
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

function makeService(rows: FakeRow[], existing: Record<string, string>) {
  const ds = makeDataSource(rows);
  const ids = makeIdentifierService(existing);
  const ingest = makeIngestService();
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new PersonStubBackfillService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ds.dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ingest as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ids as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, ds, ids, ingest };
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

    expect(emails.sort()).toEqual(['alice <alice@example.com>', 'bcc@example.com', 'cc@example.com'].sort());
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
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const service = new PersonStubBackfillService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { query } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ingest as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ids as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger as any,
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
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const service = new PersonStubBackfillService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { query } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ingest as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ids as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger as any,
    );

    const result = await service.backfill(USER);

    expect(result.range).toBeNull();
    expect(result.windows).toBe(0);
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
      expect(entity.key.startsWith('communications:participant:')).toBe(true);
    }

    void NEW_ENTITY;
  });
});
