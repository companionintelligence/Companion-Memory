import type { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { WebPushService } from '../WebPushService';

const sendNotification = jest.fn();
const setVapidDetails = jest.fn();

jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

// The factory must not close over anything declared later in this file — an
// `import` (including the transitive one `../WebPushService` makes) is
// hoisted above every other statement, so the FIRST require of
// '@ci/configuration' happens before any later `const` in this file has
// run. Mutate the mocked module's own `push.vapid` in `beforeEach` instead
// (via the `config` import above, which resolves to this same mock object).
//
// Starts from the REAL config (`requireActual`), not a bare `{ push: ... }`
// object: `LoggerService` (required transitively by `WebPushService`) reads
// `config.logging.level` at module-init time, so replacing the whole default
// export would take every other config field down with it.
jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual<{ default: Record<string, unknown> }>('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      push: { vapid: { publicKey: '', privateKey: '', subject: 'mailto:admin@companion.local' } },
    },
  };
});

function makeLogger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

const SUBSCRIPTION = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };
const PAYLOAD = { title: 'Task reminder', body: 'A task is due', url: '/', tag: 'reminder:1' };

describe('WebPushService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.push.vapid = { publicKey: '', privateKey: '', subject: 'mailto:admin@companion.local' };
  });

  it('reports unconfigured and returns a null public key when no VAPID keys are set', () => {
    const service = new WebPushService(makeLogger());

    expect(service.isConfigured()).toBe(false);
    expect(service.vapidPublicKey()).toBeNull();
  });

  it('sends and reports "ok" once both VAPID keys are configured', async () => {
    config.push.vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.test' };
    sendNotification.mockResolvedValueOnce(undefined);

    const service = new WebPushService(makeLogger());

    expect(service.isConfigured()).toBe(true);
    expect(service.vapidPublicKey()).toBe('pub');

    const result = await service.sendPush(SUBSCRIPTION, PAYLOAD);

    expect(result).toBe('ok');
    expect(setVapidDetails).toHaveBeenCalledWith('mailto:a@b.test', 'pub', 'priv');
    expect(sendNotification).toHaveBeenCalledWith(SUBSCRIPTION, JSON.stringify(PAYLOAD));
  });

  it('calls setVapidDetails only once across repeated sends', async () => {
    config.push.vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.test' };
    sendNotification.mockResolvedValue(undefined);

    const service = new WebPushService(makeLogger());

    await service.sendPush(SUBSCRIPTION, PAYLOAD);
    await service.sendPush(SUBSCRIPTION, PAYLOAD);

    expect(setVapidDetails).toHaveBeenCalledTimes(1);
  });

  it('returns "fail" without ever calling sendNotification when push is not configured', async () => {
    const service = new WebPushService(makeLogger());

    const result = await service.sendPush(SUBSCRIPTION, PAYLOAD);

    expect(result).toBe('fail');
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('refuses a half-configured keypair (public only) and stays disabled', async () => {
    config.push.vapid = { publicKey: 'pub', privateKey: '', subject: 'mailto:a@b.test' };

    const service = new WebPushService(makeLogger());
    const result = await service.sendPush(SUBSCRIPTION, PAYLOAD);

    expect(result).toBe('fail');
    expect(setVapidDetails).not.toHaveBeenCalled();
    // vapidPublicKey/isConfigured only check both being present at once, so a
    // half-set pair also reads as "not configured" to the client-facing query.
    expect(service.isConfigured()).toBe(false);
  });

  it('refuses a half-configured keypair (private only) and stays disabled', async () => {
    config.push.vapid = { publicKey: '', privateKey: 'priv', subject: 'mailto:a@b.test' };

    const service = new WebPushService(makeLogger());
    const result = await service.sendPush(SUBSCRIPTION, PAYLOAD);

    expect(result).toBe('fail');
    expect(setVapidDetails).not.toHaveBeenCalled();
  });

  /**
   * The Web Push contract this whole feature's cleanup path rests on: a
   * 404/410 from the push service means the subscription is gone. Confirmed
   * for both status codes, since either is a valid "gone" response depending
   * on the push service (see `ReminderDispatchService`'s use of this result).
   */
  it.each([404, 410])('maps a %d response to "gone"', async (statusCode) => {
    config.push.vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.test' };
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('Gone'), { statusCode }));

    const service = new WebPushService(makeLogger());
    const result = await service.sendPush(SUBSCRIPTION, PAYLOAD);

    expect(result).toBe('gone');
  });

  it('maps any other failure (network error, 5xx, malformed payload) to "fail" without throwing', async () => {
    config.push.vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.test' };
    sendNotification.mockRejectedValueOnce(
      Object.assign(new Error('Service unavailable'), { statusCode: 503 }),
    );

    const service = new WebPushService(makeLogger());

    await expect(service.sendPush(SUBSCRIPTION, PAYLOAD)).resolves.toBe('fail');
  });
});
