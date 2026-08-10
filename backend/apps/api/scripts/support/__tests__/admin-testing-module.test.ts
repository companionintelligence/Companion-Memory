import { DataSource } from 'typeorm';

import { createAdminTestingModule } from '../admin-testing-module';

/**
 * `make seed` and `make signup` boot the entire application to do their one job,
 * so any unresolvable dependency anywhere in the graph takes both of them down —
 * and with them the only supported way to create a local user. They broke exactly
 * that way once already: the schedule domain began injecting `RecallService`,
 * which the stub standing in for `AgentModule` did not provide, and the error
 * surfaced only when a developer ran the target.
 *
 * This compiles the same graph the scripts compile, so that failure is a red test
 * instead. It needs no Postgres: `compile()` resolves and constructs providers but
 * runs no lifecycle hook, so a DataSource that answers the few calls TypeORM's
 * repository factory makes is enough, and the whole thing takes well under a
 * second.
 */
const fakeRepository = new Proxy(
  {},
  {
    // `then` has to stay undefined. A Proxy that answers every key with a function
    // is a thenable, and Nest awaits provider instances — awaiting a thenable
    // whose `then` ignores its callbacks hangs the compile forever.
    get: (_target, property) => (property === 'then' ? undefined : () => undefined),
  },
);

const fakeDataSource = {
  entityMetadatas: [],
  options: { type: 'postgres' },
  manager: {},
  getRepository: () => fakeRepository,
  isInitialized: true,
} as unknown as DataSource;

describe('admin script testing module', () => {
  it('resolves every dependency in the application graph', async () => {
    const module = await createAdminTestingModule()
      .overrideProvider(DataSource)
      .useValue(fakeDataSource)
      .compile();

    expect(module).toBeDefined();

    await module.close();
  });
});
