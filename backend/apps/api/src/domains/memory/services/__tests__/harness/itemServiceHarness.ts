import type { UserServiceContext } from '@ci/common/context';

import { ItemBaseEntity } from '../../../entities/ItemBaseEntity';
import { ItemEntity } from '../../../entities/ItemEntity';
import { ItemService } from '../../ItemService';

import { makeInsertBuilder } from './insertBuilder';
import { noopGraphDeltaWriter } from './noopGraphDeltaWriter';

export const ITEM_HARNESS_USER = '00000000-0000-0000-0000-0000000000aa';

export const ITEM_HARNESS_CONTEXT: UserServiceContext = {
  userId: ITEM_HARNESS_USER,
} as UserServiceContext;

/**
 * An {@link ItemService} wired to in-memory stand-ins for both halves of its
 * CTI aggregate, so a test can assert on exactly what each half was asked to
 * write. Shared by the CTI-shape suite and the physical-properties suite.
 */
export function makeItemHarness() {
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
    // update/remove trail reads the base name inside the aggregate transaction.
    findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) =>
      Object.assign(new ItemBaseEntity(), { id, name: 'Camera' }),
    ),
    metadata: { target: ItemBaseEntity, columns: { length: 10 } },
    createQueryBuilder: jest.fn(() => makeInsertBuilder(baseInsert)),
    // insertBaseRows' ownership check: no base row held by another owner.
    query: jest.fn(async () => []),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    noopGraphDeltaWriter() as any,
  );

  return { service, detailRepo, baseRepo, baseInsert, send };
}
