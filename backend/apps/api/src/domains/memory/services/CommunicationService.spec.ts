import type { UserServiceContext } from '@ci/common/context';
import { INGEST_REFRESH_COLUMNS, bulkInsertIdempotent } from '@ci/common/persistence';

import { CommunicationBaseEntity } from '../entities/CommunicationBaseEntity';
import { CommunicationEntity } from '../entities/CommunicationEntity';
import { CommunicationType } from '../types';

import { makeInsertBuilder } from './__tests__/harness/insertBuilder';
import { CommunicationService } from './CommunicationService';

jest.mock('@ci/common/persistence', () => ({
  ...jest.requireActual('@ci/common/persistence'),
  bulkInsertIdempotent: jest.fn(),
}));

const bulkInsertMock = bulkInsertIdempotent as jest.Mock;

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function makeService() {
  const baseInsert = {} as { values?: unknown[]; conflict?: string };

  const baseRepo = {
    create: jest.fn((partial: Partial<CommunicationBaseEntity>) =>
      Object.assign(new CommunicationBaseEntity(), partial),
    ),
    save: jest.fn(async (entity: CommunicationBaseEntity) => entity),
    update: jest.fn(async () => ({ affected: 1 })),
    delete: jest.fn(async () => ({ affected: 1 })),
    metadata: { target: CommunicationBaseEntity, columns: { length: 10 } },
    createQueryBuilder: jest.fn(() => makeInsertBuilder(baseInsert)),
  };

  const repository: Record<string, unknown> = {
    create: jest.fn((partial: Partial<CommunicationEntity>) =>
      Object.assign(new CommunicationEntity(), partial),
    ),
    save: jest.fn(async (entity: CommunicationEntity) => entity),
    findOne: jest.fn(),
  };
  // Writes run in a spanning transaction; the manager dispatches by entity class.
  repository.manager = {
    transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
      cb({
        getRepository: (cls: unknown): unknown => (cls === CommunicationBaseEntity ? baseRepo : repository),
        withRepository: (): unknown => repository,
      }),
    ),
  };

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const dataSource = { transaction: jest.fn(), getRepository: jest.fn() };

  const service = new CommunicationService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
  );

  return { service, send, repository, baseRepo, baseInsert };
}

const makeInput = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    communication_type: CommunicationType.EMAIL,
    time: new Date('2024-01-01T00:00:00.000Z'),
    content: `body ${i}`,
    direction: 'inbound' as const,
    id: `c-${i}`,
    source_type: 'email',
    source_system: 'gmail',
    source_id: `msg-${i}`,
  }));

/**
 * Contract for the bulk ingest path after 20260807072321 de-hypertabled
 * ci.communications: createMany delegates the whole batch to the shared
 * bulkInsertIdempotent (which owns chunking, intra-batch dedup, and the ON
 * CONFLICT self-heal), arbitrated on the PURE provenance triple — `time` must
 * never re-enter the conflict key, and no timeColumn bound may be passed
 * (a re-sent triple's importer time can drift from the stored row's).
 */
describe('CommunicationService bulk createMany', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: every built entity is reported inserted, in input order.
    bulkInsertMock.mockImplementation(async ({ entities }: { entities: CommunicationEntity[] }) =>
      entities.map((entity) => ({ entity, inserted: true })),
    );
  });

  it('delegates the batch to bulkInsertIdempotent with the time-free triple arbiter and the communication refresh columns', async () => {
    const { service, send } = makeService();

    const result = await service.createMany(CONTEXT, makeInput(3));

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('c-0');
    expect(result[2].id).toBe('c-2');

    expect(bulkInsertMock).toHaveBeenCalledTimes(1);
    const options = bulkInsertMock.mock.calls[0][0];
    expect(options.entities).toHaveLength(3);
    expect(options.primaryKey).toBe('id');
    expect(options.scope).toEqual({ userId: USER });
    // The clean key the de-hypertabling restored: no `time` in the arbiter.
    expect(options.conflictTarget).toBe(
      '(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL',
    );
    expect(options.conflictTarget).not.toContain('time');
    // No hypertable, no chunk-exclusion bound — and time is not stable across
    // re-syncs, so a time bound would exclude legitimate canonical rows.
    expect(options.timeColumn).toBeUndefined();
    // Re-sends self-heal the source-derived columns via ON CONFLICT DO UPDATE.
    expect(options.conflictUpdateColumns).toBe(INGEST_REFRESH_COLUMNS.communication);

    // Bulk path emits no per-row events (indexing is deferred to the
    // post-load backfill sweep).
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the canonical row for a deduped re-send, in input order', async () => {
    const { service } = makeService();

    // The helper reports the second row as found-not-inserted, hydrated as the
    // pre-existing canonical entity (different id than the input row).
    bulkInsertMock.mockImplementationOnce(async ({ entities }: { entities: CommunicationEntity[] }) => [
      { entity: entities[0], inserted: true },
      {
        entity: Object.assign(new CommunicationEntity(), entities[1], { id: 'canonical-existing' }),
        inserted: false,
      },
    ]);

    const result = await service.createMany(CONTEXT, makeInput(2));

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('c-0');
    expect(result[1].id).toBe('canonical-existing');
  });

  it('stamps userId and maps snake_case DTO fields onto every built entity', async () => {
    const { service } = makeService();

    await service.createMany(CONTEXT, makeInput(1));

    const [entity] = bulkInsertMock.mock.calls[0][0].entities as CommunicationEntity[];
    expect(entity.userId).toBe(USER);
    expect(entity.communicationType).toBe(CommunicationType.EMAIL);
    expect(entity.sourceType).toBe('email');
    expect(entity.sourceSystem).toBe('gmail');
    expect(entity.sourceId).toBe('msg-0');
  });

  it('returns an empty array (and touches nothing) for empty input', async () => {
    const { service } = makeService();

    const result = await service.createMany(CONTEXT, []);

    expect(result).toEqual([]);
    expect(bulkInsertMock).not.toHaveBeenCalled();
  });
});
