import { PersonStubBackfillRequestListener } from './PersonStubBackfillRequestListener';

const USER = '00000000-0000-0000-0000-0000000000aa';

function make() {
  const backfill = jest.fn(async () => ({
    examined: 10,
    identifiersSeen: 4,
    identifiersExisting: 1,
    peopleCreated: 3,
    identifiersIndexed: 3,
    errors: [],
    windows: 1,
    range: null,
  }));
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const listener = new PersonStubBackfillRequestListener({ backfill } as never, logger as never);

  return { listener, backfill, logger };
}

describe('PersonStubBackfillRequestListener', () => {
  it('runs the people-stub pass for the requested owner', async () => {
    const { listener, backfill, logger } = make();

    await listener.handleRequest({ userId: USER, requestedBy: 'import-run:r1' });

    expect(backfill).toHaveBeenCalledWith(USER);
    expect(logger.log).toHaveBeenCalledWith(
      'People-stub backfill complete',
      expect.objectContaining({ userId: USER, requestedBy: 'import-run:r1', peopleCreated: 3 }),
    );
  });

  it('refuses a request that names no owner', async () => {
    const { listener, backfill, logger } = make();

    await listener.handleRequest({ requestedBy: 'import-run:r1' });

    expect(backfill).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
