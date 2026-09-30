import { SYSTEM_USER } from '@ci/common/context';

import { UserCreatedEvent } from '../../events';
import { UserService } from '../UserService';

jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hashed'), compare: jest.fn() }));

const SYSTEM = { userId: SYSTEM_USER } as never;

const NEW_USER = { id: 'user-1', name: 'J Smith', email: 'jsmith@example.com', password: 'correct horse' };

/**
 * What TypeORM's Postgres driver resolves a statement that produced `rows` to: `[rows, rowCount]`
 * when the outer command is an UPDATE or DELETE, the rows themselves otherwise. (A CTE-prefixed
 * statement is keyed on what follows the CTE; nothing this suite answers is one.)
 */
const driverResult = (sql: string, rows: unknown[]) =>
  /^\s*(update|delete)\b/i.test(sql) ? [rows, rows.length] : rows;

/**
 * A UserService over a repository that records where each write happened: in a transaction (and
 * whether that transaction committed), or on its own.
 */
function makeService() {
  const log: string[] = [];
  const managers: unknown[] = [];

  const userRepository = {
    create: jest.fn((data: object) => ({ ...data })),
    save: jest.fn(async (entity: object) => {
      log.push('save, on its own');

      return { ...entity, role: 'user' };
    }),
    manager: {
      transaction: jest.fn(async (run: (manager: unknown) => Promise<unknown>) => {
        const n = managers.length + 1;
        const manager = {
          save: jest.fn(async (entity: object) => {
            log.push(`save, in transaction ${n}`);

            return { ...entity, role: 'user' };
          }),
          query: jest.fn(async (sql: string) => driverResult(sql, [])),
        };

        managers.push(manager);

        try {
          const result = await run(manager);

          log.push(`commit ${n}`);

          return result;
        } catch (err) {
          log.push(`rollback ${n}`);

          throw err;
        }
      }),
    },
  };

  const eventService = {
    send: jest.fn(async () => {
      log.push('UserCreated');
    }),
  };

  const service = new UserService(userRepository as never, eventService as never);

  return { service, userRepository, eventService, log, managers };
}

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * `create`'s `alongside`: work an account must not exist without — redeeming the invitation that
 * admitted it — committed or rolled back with the INSERT itself.
 */
describe('UserService.create — work committed alongside the account', () => {
  it('runs it in the transaction that inserts the account, through that transaction', async () => {
    const { service, log, managers } = makeService();
    const alongside = jest.fn(async () => {
      log.push('alongside');
    });

    await service.create(SYSTEM, NEW_USER, alongside);

    expect(alongside).toHaveBeenCalledWith(managers[0], expect.objectContaining({ id: 'user-1' }));
    expect(log.slice(0, 3)).toEqual(['save, in transaction 1', 'alongside', 'commit 1']);
    // Announced only once both are committed.
    expect(log.at(-1)).toBe('UserCreated');
  });

  it('rolls the account back when it throws, and hands the caller that error as thrown', async () => {
    const { service, eventService, log } = makeService();
    const refusal = new Error('the invitation was redeemed by another signup first');

    await expect(
      service.create(SYSTEM, NEW_USER, async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);

    expect(log).toEqual(['save, in transaction 1', 'rollback 1']);
    // An account that does not exist is neither claimed nor announced.
    expect(eventService.send).not.toHaveBeenCalledWith(UserCreatedEvent, expect.anything());
  });

  it('without it, saves the account on its own — a lone INSERT needs no transaction', async () => {
    const { service, userRepository, log } = makeService();

    await service.create(SYSTEM, NEW_USER);

    expect(userRepository.save).toHaveBeenCalledTimes(1);
    expect(log[0]).toBe('save, on its own');
  });
});
