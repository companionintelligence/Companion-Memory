import type { UserServiceContext } from '@ci/common/context';
import { bulkInsertIdempotent } from '@ci/common/persistence';

import { ItemBaseEntity } from '../../entities/ItemBaseEntity';
import { ItemEntity } from '../../entities/ItemEntity';
import { ItemService } from '../ItemService';

import { makeInsertBuilder } from './harness/insertBuilder';

// createMany's detail phase is bulkInsertIdempotent's own (separately tested)
// concern; here it is mocked so the tests can steer which rows count as
// `inserted` and assert the base-row phase reacts correctly.
jest.mock('@ci/common/persistence', () => ({
  ...jest.requireActual('@ci/common/persistence'),
  bulkInsertIdempotent: jest.fn(),
}));

const bulkInsertMock = bulkInsertIdempotent as jest.Mock;

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function makeHarness() {
  const baseInsert = {} as { values?: unknown[]; conflict?: string };

  const detailRepo = {
    create: jest.fn((partial: Partial<ItemEntity>) => Object.assign(new ItemEntity(), partial)),
    save: jest.fn(async (entity: ItemEntity) => entity),
    findOne: jest.fn(),
    update: jest.fn(async () => ({ affected: 1 })),
    metadata: { target: ItemEntity, columns: { length: 43 } },
    manager: {} as Record<string, unknown>,
  };

  // Base rows are the owners of name/description; reads compose from here.
  const baseRepo = {
    create: jest.fn((partial: Partial<ItemBaseEntity>) => Object.assign(new ItemBaseEntity(), partial)),
    save: jest.fn(async (entity: ItemBaseEntity) => entity),
    update: jest.fn(async () => ({ affected: 1 })),
    delete: jest.fn(async () => ({ affected: 1 })),
    find: jest.fn(async () => [] as ItemBaseEntity[]),
    metadata: { target: ItemBaseEntity, columns: { length: 10 } },
    createQueryBuilder: jest.fn(() => makeInsertBuilder(baseInsert)),
  };

  // The transactional manager dispatches by entity class, so both halves of the
  // aggregate resolve to their mocks inside one "transaction".
  const manager = {
    getRepository: (cls: unknown) => (cls === ItemBaseEntity ? baseRepo : detailRepo),
    withRepository: () => detailRepo,
  };
  detailRepo.manager = {
    transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
  };

  const send = jest.fn(async () => []);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ItemService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    detailRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
  );

  return { service, detailRepo, baseRepo, baseInsert, send };
}

beforeEach(() => {
  bulkInsertMock.mockReset();
});

describe('ItemService CTI create', () => {
  it('writes the base row (owner of name/description) and the detail row with the SAME uuid', async () => {
    const { service, detailRepo, baseRepo, send } = makeHarness();

    const item = await service.create(CONTEXT, { id: 'i1', name: 'Camera', description: 'DSLR' });

    // Base row: shared uuid, the ONLY holder of name/description, linked pair.
    expect(baseRepo.save).toHaveBeenCalledTimes(1);
    expect(baseRepo.save.mock.calls[0][0]).toMatchObject({
      id: 'i1',
      name: 'Camera',
      description: 'DSLR',
      userId: USER,
      linkedTable: 'inventory',
      linkedId: 'i1',
    });

    // Detail row: same uuid, NO name/description (normalized away).
    expect(detailRepo.save).toHaveBeenCalledTimes(1);
    expect(detailRepo.save.mock.calls[0][0]).toMatchObject({ id: 'i1' });
    expect(detailRepo.save.mock.calls[0][0]).not.toHaveProperty('name');

    // Egress composes the pair.
    expect(item.id).toBe('i1');
    expect(item.name).toBe('Camera');
    expect(item.description).toBe('DSLR');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('ItemService CTI reads', () => {
  it('composes name/description from the base rows in one batched fetch', async () => {
    const { service, detailRepo, baseRepo } = makeHarness();

    const detail = Object.assign(new ItemEntity(), { id: 'i1', userId: USER });
    detailRepo.findOne.mockResolvedValue(detail);
    baseRepo.find.mockResolvedValue([
      Object.assign(new ItemBaseEntity(), { id: 'i1', name: 'Camera', description: 'DSLR' }),
    ]);

    const item = await service.findById(CONTEXT, 'i1');

    expect(baseRepo.find).toHaveBeenCalledTimes(1);
    expect(item?.name).toBe('Camera');
    expect(item?.description).toBe('DSLR');
  });
});

describe('ItemService CTI update', () => {
  it('routes name/description to the base row and detail fields to the detail row', async () => {
    const { service, detailRepo, baseRepo } = makeHarness();

    const row = Object.assign(new ItemEntity(), { id: 'i1', userId: USER });
    detailRepo.findOne.mockResolvedValue(row);
    baseRepo.find.mockResolvedValue([
      Object.assign(new ItemBaseEntity(), { id: 'i1', name: 'New', description: null }),
    ]);

    const result = await service.update(CONTEXT, 'i1', { name: 'New', brand: 'Canon' });

    expect(baseRepo.update).toHaveBeenCalledWith({ id: 'i1' }, { name: 'New' });
    expect(detailRepo.update).toHaveBeenCalledTimes(1);
    expect((detailRepo.update.mock.calls[0] as unknown[])[1]).toMatchObject({ brand: 'Canon' });
    expect(result?.name).toBe('New');
  });

  it('patches only the provided base half (name without clobbering description)', async () => {
    const { service, detailRepo, baseRepo } = makeHarness();

    const row = Object.assign(new ItemEntity(), { id: 'i1', userId: USER });
    detailRepo.findOne.mockResolvedValue(row);

    await service.update(CONTEXT, 'i1', { name: 'Renamed' });

    expect(baseRepo.update).toHaveBeenCalledWith({ id: 'i1' }, { name: 'Renamed' });
  });

  it('does not touch the base row when the patch has no name/description', async () => {
    const { service, detailRepo, baseRepo } = makeHarness();

    const row = Object.assign(new ItemEntity(), { id: 'i1', userId: USER });
    detailRepo.findOne.mockResolvedValue(row);

    await service.update(CONTEXT, 'i1', { condition: 'good' });

    expect(baseRepo.update).not.toHaveBeenCalled();
  });
});

describe('ItemService CTI remove', () => {
  it('deletes via the BASE row (FK cascades the detail)', async () => {
    const { service, detailRepo, baseRepo } = makeHarness();

    const row = Object.assign(new ItemEntity(), { id: 'i1', userId: USER });
    detailRepo.findOne.mockResolvedValueOnce(row);

    const removed = await service.remove(CONTEXT, 'i1');

    expect(removed).toBe(true);
    expect(baseRepo.delete).toHaveBeenCalledWith({ id: 'i1' });
  });

  it('returns false (no base delete) when the scoped item does not exist', async () => {
    const { service, detailRepo, baseRepo } = makeHarness();
    detailRepo.findOne.mockResolvedValueOnce(null);

    const removed = await service.remove(CONTEXT, 'missing');

    expect(removed).toBe(false);
    expect(baseRepo.delete).not.toHaveBeenCalled();
  });
});

describe('ItemService CTI createMany', () => {
  it('writes base rows (from DTO values) for INSERTED detail rows only, composing egress from the base fetch', async () => {
    const { service, baseInsert, baseRepo, send } = makeHarness();

    const insertedRow = Object.assign(new ItemEntity(), { id: 'i1', userId: USER, ownerUserId: USER });
    const existingRow = Object.assign(new ItemEntity(), { id: 'i2', userId: USER, ownerUserId: USER });

    bulkInsertMock.mockResolvedValue([
      { entity: insertedRow, inserted: true },
      { entity: existingRow, inserted: false },
    ]);

    // The composition fetch returns both base rows — including the pre-existing
    // one, whose canonical name this batch never carried.
    baseRepo.find.mockResolvedValue([
      Object.assign(new ItemBaseEntity(), { id: 'i1', name: 'Camera', description: null }),
      Object.assign(new ItemBaseEntity(), { id: 'i2', name: 'Existing Lens', description: 'kept' }),
    ]);

    const result = await service.createMany(CONTEXT, [
      { id: 'i1', name: 'Camera', sourceType: 'scan', sourceId: 's1' },
      { id: 'i2', name: 'Lens', sourceType: 'scan', sourceId: 's2' },
    ]);

    // The bulk detail phase joined the spanning transaction.
    expect(bulkInsertMock).toHaveBeenCalledTimes(1);
    expect(bulkInsertMock.mock.calls[0][0].manager).toBeDefined();

    // Base rows for the inserted set only, values from the DTO.
    expect(baseInsert.values).toHaveLength(1);
    expect(baseInsert.values?.[0]).toMatchObject({
      id: 'i1',
      name: 'Camera',
      linkedTable: 'inventory',
      linkedId: 'i1',
    });
    expect(baseInsert.conflict).toBe('(entity_id) DO NOTHING');

    // Egress: pre-existing rows expose their CANONICAL base name, not the
    // batch's would-be value.
    expect(result.map((i) => [i.id, i.name])).toEqual([
      ['i1', 'Camera'],
      ['i2', 'Existing Lens'],
    ]);
    expect(send).not.toHaveBeenCalled();
  });
});
