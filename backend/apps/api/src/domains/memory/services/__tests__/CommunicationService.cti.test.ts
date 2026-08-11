import type { ServiceContext, UserServiceContext } from '@ci/common/context';
import { bulkInsertIdempotent } from '@ci/common/persistence';

import { CommunicationBaseEntity } from '../../entities/CommunicationBaseEntity';
import { CommunicationEntity } from '../../entities/CommunicationEntity';
import { CommunicationType } from '../../types';
import { CommunicationService } from '../CommunicationService';

import { makeInsertBuilder } from './harness/insertBuilder';

jest.mock('@ci/common/persistence', () => ({
  ...jest.requireActual('@ci/common/persistence'),
  bulkInsertIdempotent: jest.fn(),
}));

const bulkInsertMock = bulkInsertIdempotent as jest.Mock;

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function makeHarness() {
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
    update: jest.fn(async () => ({ affected: 1 })),
    findOne: jest.fn(),
  };
  repository.manager = {
    transaction: jest.fn(async (cb: (m: unknown) => unknown) =>
      cb({
        getRepository: (cls: unknown): unknown => (cls === CommunicationBaseEntity ? baseRepo : repository),
        withRepository: (): unknown => repository,
      }),
    ),
  };

  const send = jest.fn(async () => []);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new CommunicationService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { transaction: jest.fn(), getRepository: jest.fn() } as any,
  );

  return { service, repository, baseRepo, baseInsert, send };
}

beforeEach(() => {
  bulkInsertMock.mockReset();
});

describe('CommunicationService CTI create', () => {
  it('writes a base row with the derived label (subject first) and the SAME uuid', async () => {
    const { service, baseRepo } = makeHarness();

    await service.create(CONTEXT, {
      id: 'c1',
      time: new Date('2026-01-01T00:00:00Z'),
      communication_type: CommunicationType.EMAIL,
      direction: 'inbound',
      subject: 'Re: dinner',
      content: 'long email body',
      summary: 'a dinner plan',
    });

    expect(baseRepo.save).toHaveBeenCalledTimes(1);
    expect(baseRepo.save.mock.calls[0][0]).toMatchObject({
      id: 'c1',
      name: 'Re: dinner',
      description: 'a dinner plan',
      userId: USER,
      linkedTable: 'communications',
      linkedId: 'c1',
    });
  });

  it('derives the label from content when subject/preview are absent (chat shape)', async () => {
    const { service, baseRepo } = makeHarness();

    await service.create(CONTEXT, {
      id: 'c2',
      time: new Date('2026-01-01T00:00:00Z'),
      communication_type: CommunicationType.SMS,
      direction: 'inbound',
      content: 'see you at 6',
    });

    expect(baseRepo.save.mock.calls[0][0]).toMatchObject({ id: 'c2', name: 'see you at 6' });
  });
});

describe('CommunicationService CTI update', () => {
  it('re-derives the base label when a label source changes', async () => {
    const { service, repository, baseRepo } = makeHarness();
    (repository.findOne as jest.Mock).mockResolvedValue(
      Object.assign(new CommunicationEntity(), {
        id: 'c1',
        userId: USER,
        subject: null,
        preview: null,
        content: 'old',
        summary: null,
      }),
    );

    await service.update(CONTEXT as ServiceContext, 'c1', { content: 'new text' });

    expect(baseRepo.update).toHaveBeenCalledWith({ id: 'c1' }, { name: 'new text', description: null });
  });

  it('leaves the base row alone when no label source changed', async () => {
    const { service, repository, baseRepo } = makeHarness();
    (repository.findOne as jest.Mock).mockResolvedValue(
      Object.assign(new CommunicationEntity(), { id: 'c1', userId: USER, content: 'x' }),
    );

    // UpdateCommunicationDto types `content` as required, but runtime callers
    // (GraphQL partial updates) can omit it — model that shape here.
    await service.update(CONTEXT as ServiceContext, 'c1', {
      category: 'work',
    } as Parameters<CommunicationService['update']>[2]);

    expect(baseRepo.update).not.toHaveBeenCalled();
  });
});

describe('CommunicationService CTI remove', () => {
  it('deletes via the BASE row (FK cascades the detail)', async () => {
    const { service, repository, baseRepo } = makeHarness();
    (repository.findOne as jest.Mock).mockResolvedValueOnce(
      Object.assign(new CommunicationEntity(), { id: 'c1', userId: USER }),
    );

    const removed = await service.remove(CONTEXT as ServiceContext, 'c1');

    expect(removed).toBe(true);
    expect(baseRepo.delete).toHaveBeenCalledWith({ id: 'c1' });
  });
});

describe('CommunicationService CTI createMany', () => {
  it('UPSERTS base rows for every result (labels follow the refresh), deduped by id', async () => {
    const { service, baseInsert } = makeHarness();

    const rowA = Object.assign(new CommunicationEntity(), {
      id: 'c1',
      userId: USER,
      subject: 'refreshed subject',
      content: 'body',
    });
    const rowB = Object.assign(new CommunicationEntity(), {
      id: 'c2',
      userId: USER,
      subject: null,
      preview: null,
      content: 'chat line',
    });

    bulkInsertMock.mockResolvedValue([
      { entity: rowA, inserted: false }, // pre-existing, refreshed by DO UPDATE
      { entity: rowB, inserted: true },
      { entity: rowA, inserted: false }, // intra-batch duplicate triple
    ]);

    await service.createMany(CONTEXT, [
      {
        id: 'c1',
        time: new Date(),
        communication_type: CommunicationType.EMAIL,
        direction: 'inbound',
        content: 'body',
        source_type: 'email',
        source_system: 'gmail',
        source_id: 'm1',
      },
      {
        id: 'c2',
        time: new Date(),
        communication_type: CommunicationType.SMS,
        direction: 'inbound',
        content: 'chat line',
        source_type: 'sms',
        source_system: 'imessage',
        source_id: 'm2',
      },
      {
        id: 'c1-dup',
        time: new Date(),
        communication_type: CommunicationType.EMAIL,
        direction: 'inbound',
        content: 'body',
        source_type: 'email',
        source_system: 'gmail',
        source_id: 'm1',
      },
    ]);

    // The bulk detail phase joined the spanning transaction.
    expect(bulkInsertMock.mock.calls[0][0].manager).toBeDefined();

    // Base rows for BOTH results (refreshed + inserted), deduped to one row
    // per id, labels derived from the hydrated rows.
    expect(baseInsert.values).toHaveLength(2);
    expect(baseInsert.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'c1', name: 'refreshed subject' }),
        expect.objectContaining({ id: 'c2', name: 'chat line' }),
      ]),
    );
    expect(baseInsert.conflict).toBe(
      '(entity_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description ' +
        'WHERE (entities.name, entities.description) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.description)',
    );
  });
});
