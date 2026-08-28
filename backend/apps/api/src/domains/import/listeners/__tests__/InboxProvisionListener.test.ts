import { InboxProvisionListener } from '../InboxProvisionListener';

/**
 * Best-effort by design (see the class doc): an unavailable inbox mount must
 * not make signup fail, so every failure path here asserts a swallow, not a
 * throw. What is tested is exactly that contract — provision the right
 * user's inbox, look the user up by the payload's id (not trust a stale
 * email), stay quiet when the user is already gone, and survive a pg-boss
 * redelivery of the same `user.created` job without erroring or double-
 * provisioning anything the service itself does not already dedupe.
 */

const payload = { userId: '11111111-1111-4111-8111-111111111111' };
const user = { id: payload.userId, email: 'new-user@example.com' };

function makeListener(
  overrides: {
    findById?: jest.Mock;
    provisionUserInbox?: jest.Mock;
  } = {},
) {
  const users = {
    findById: overrides.findById ?? jest.fn(async () => user),
  };

  const inbox = {
    provisionUserInbox: overrides.provisionUserInbox ?? jest.fn(async () => undefined),
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  return {
    listener: new InboxProvisionListener(inbox as never, users as never, logger as never),
    users,
    inbox,
    logger,
  };
}

describe('InboxProvisionListener.provisionForNewUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it("provisions the new user's inbox by their looked-up email", async () => {
    const { listener, users, inbox, logger } = makeListener();

    await listener.provisionForNewUser(payload);

    expect(users.findById).toHaveBeenCalledWith({ userId: payload.userId }, payload.userId);
    expect(inbox.provisionUserInbox).toHaveBeenCalledWith(user.email);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Provisioned'),
      expect.objectContaining({ userId: payload.userId }),
    );
  });

  it('does nothing when the user row is already gone', async () => {
    // A row deleted between the event firing and the job running (or a
    // replayed job for an account since removed) must not conjure a folder
    // for an email the listener has no business guessing at.
    const { listener, inbox, logger } = makeListener({
      findById: jest.fn(async () => null),
    });

    await listener.provisionForNewUser(payload);

    expect(inbox.provisionUserInbox).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('swallows a lookup failure instead of failing signup', async () => {
    const { listener, inbox, logger } = makeListener({
      findById: jest.fn(async () => {
        throw new Error('connection terminated');
      }),
    });

    await expect(listener.provisionForNewUser(payload)).resolves.toBeUndefined();

    expect(inbox.provisionUserInbox).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not provision'),
      expect.objectContaining({ userId: payload.userId, error: 'connection terminated' }),
    );
  });

  it('swallows a provisioning failure (read-only or absent inbox mount) instead of failing signup', async () => {
    const { listener, logger } = makeListener({
      provisionUserInbox: jest.fn(async () => {
        throw new Error('EROFS: read-only file system');
      }),
    });

    await expect(listener.provisionForNewUser(payload)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not provision'),
      expect.objectContaining({ userId: payload.userId, error: 'EROFS: read-only file system' }),
    );
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('re-runs cleanly on a pg-boss redelivery of the same job', async () => {
    // pg-boss redelivers on anything short of an ack; nothing here dedupes by
    // job id, so a redelivered `user.created` calls straight back through to
    // the same lookup and the same (idempotent) provision call, rather than
    // erroring or skipping the second attempt.
    const { listener, users, inbox, logger } = makeListener();

    await listener.provisionForNewUser(payload);
    await listener.provisionForNewUser(payload);

    expect(users.findById).toHaveBeenCalledTimes(2);
    expect(inbox.provisionUserInbox).toHaveBeenNthCalledWith(1, user.email);
    expect(inbox.provisionUserInbox).toHaveBeenNthCalledWith(2, user.email);
    expect(logger.log).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
