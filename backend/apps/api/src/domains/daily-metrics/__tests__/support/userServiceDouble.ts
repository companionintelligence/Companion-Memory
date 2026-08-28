import type { Repository } from 'typeorm';

import type { EventService } from '@ci/domains/events';
import type { UserEntity } from '@ci/domains/user';
import { UserService } from '@ci/domains/user';

export type UserRow = Partial<UserEntity> & { id: string; onboarded: boolean };

/**
 * The real UserService over a repository that actually honours `where`, so the
 * fan-out audience is exercised rather than asserted: a caller that asks for
 * every row gets every row back here, exactly as it would from Postgres.
 */
export function makeUserService(rows: UserRow[]): UserService {
  const repository = {
    find: jest.fn(async (options?: { where?: Partial<UserEntity> }) => {
      const where = options?.where ?? {};

      return rows.filter((row) =>
        Object.entries(where).every(([column, value]) => row[column as keyof UserRow] === value),
      );
    }),
  } as unknown as Repository<UserEntity>;

  return new UserService(repository, { send: jest.fn(async () => []) } as unknown as EventService);
}
