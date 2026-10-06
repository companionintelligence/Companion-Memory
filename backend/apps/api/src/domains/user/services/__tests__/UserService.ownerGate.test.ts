import { SYSTEM_USER } from '@ci/common/context';

import { ApplianceOwnerRequiredError, ownerIsDesignated } from '../../applianceOwner';
import { UserService } from '../UserService';

jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hashed'), compare: jest.fn() }));

jest.mock('../../applianceOwner', () => ({
  ...jest.requireActual('../../applianceOwner'),
  ownerIsDesignated: jest.fn(),
}));

const gate = ownerIsDesignated as jest.Mock;
const SYSTEM = { userId: SYSTEM_USER } as never;
const ACCOUNT = { name: 'Account', email: 'account@example.com', password: 'correct horse' };

/** A UserService whose appliance has accounts or not, recording what the creating transaction did. */
function makeService({ hasAccounts }: { hasAccounts: boolean }) {
  const steps: string[] = [];
  const manager = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        steps.push('lock');

        return [];
      }

      if (sql.includes('SELECT EXISTS (SELECT 1 FROM ci.users)')) {
        steps.push('first?');

        return [{ present: hasAccounts }];
      }

      if (sql.includes("SET role = 'admin'")) {
        return hasAccounts ? [] : [{ id: 'user-1' }];
      }

      throw new Error(`unexpected statement: ${sql}`);
    }),
    save: jest.fn(async (entity: object) => {
      steps.push('insert');

      return { ...entity, role: 'user' };
    }),
  };
  const userRepository = {
    create: jest.fn((data: object) => data),
    manager: {
      query: jest.fn(async () => [{ present: hasAccounts }]),
      transaction: jest.fn(async (run: (m: unknown) => Promise<unknown>) => run(manager)),
    },
  };
  const eventService = { send: jest.fn(async () => undefined) };

  return {
    service: new UserService(userRepository as never, eventService as never),
    steps,
    eventService,
  };
}

/**
 * With an owner named at install, the FIRST account is created only for a caller that established
 * it is the owner's. Decided in the transaction that writes it, under the claim lock, for every
 * way in: `create()` as much as `createFirstAccount()`, because with signup codes off a plain
 * `create()` is what makes the first account.
 */
describe('UserService — the first account belongs to the owner named at install', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['create', (service: UserService) => service.create(SYSTEM, ACCOUNT)],
    ['createFirstAccount', (service: UserService) => service.createFirstAccount(SYSTEM, ACCOUNT)],
  ])('%s refuses an empty appliance to a caller who did not show they are the owner', async (_name, run) => {
    gate.mockReturnValue(true);
    const { service, steps, eventService } = makeService({ hasAccounts: false });

    await expect(run(service)).rejects.toBeInstanceOf(ApplianceOwnerRequiredError);
    expect(steps).toEqual(['lock', 'first?']);
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('creates the first account for the owner, as administrator', async () => {
    gate.mockReturnValue(true);
    const { service, steps } = makeService({ hasAccounts: false });

    const user = await service.createFirstAccount(SYSTEM, ACCOUNT, undefined, { designatedOwner: true });

    expect(user?.role).toBe('admin');
    expect(steps).toEqual(['lock', 'first?', 'insert']);
  });

  it('does not stand in the way once the appliance has an account', async () => {
    gate.mockReturnValue(true);
    const { service, steps } = makeService({ hasAccounts: true });

    await expect(service.create(SYSTEM, ACCOUNT)).resolves.toEqual(expect.objectContaining({ role: 'user' }));
    expect(steps).toEqual(['lock', 'first?', 'insert']);
  });

  it('leaves an appliance that names no owner to whoever is first, as before', async () => {
    gate.mockReturnValue(false);
    const { service, steps } = makeService({ hasAccounts: false });

    await expect(service.create(SYSTEM, ACCOUNT)).resolves.toEqual(
      expect.objectContaining({ role: 'admin' }),
    );
    // No owner to check for, so no extra question is asked.
    expect(steps).toEqual(['lock', 'insert']);
  });
});
