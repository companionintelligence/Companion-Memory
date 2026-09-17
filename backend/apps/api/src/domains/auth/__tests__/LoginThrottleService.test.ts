// Small, fast numbers so the window/lockout boundaries are readable in the
// tests below; the shipped defaults are 10 / 900s / 900s.
const mockLoginThrottleConfig = {
  enabled: true,
  maxAttempts: 3,
  windowSeconds: 60,
  lockoutSeconds: 120,
};

jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      auth: {
        ...actual.auth,
        // A getter, not a spread: the service reads the block on every call so a
        // test can flip `enabled` between assertions.
        get loginThrottle() {
          return mockLoginThrottleConfig;
        },
      },
    },
  };
});

import type { LoggerService } from '@ci/common/logging';

import { LoginThrottleService } from '../services/LoginThrottleService';

const IP = '203.0.113.9';
const USER = 'owner@example.com';
const FLOOD_IP = '198.51.100.77';

/** Mirrors MAX_TRACKED_IDENTITIES in the service, which is not exported. */
const MAX_TRACKED_IDENTITIES = 10_000;

const mockLogger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

function trackedCount(service: LoginThrottleService): number {
  return (service as unknown as { attempts: Map<string, unknown> }).attempts.size;
}

function sourceCount(service: LoginThrottleService): number {
  return (service as unknown as { sources: Map<string, unknown> }).sources.size;
}

/**
 * Fill the identity map past its ceiling with live counters, the way an attacker
 * would: a fresh username per request, all inside one window.
 */
function floodIdentityMap(service: LoginThrottleService, now: number, past = 1_000): void {
  for (let i = 0; i < MAX_TRACKED_IDENTITIES + past; i += 1) {
    service.recordFailure(FLOOD_IP, `junk-${i}@example.com`, now);
  }
}

describe('LoginThrottleService', () => {
  let service: LoginThrottleService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoginThrottleConfig.enabled = true;
    mockLoginThrottleConfig.maxAttempts = 3;
    mockLoginThrottleConfig.windowSeconds = 60;
    mockLoginThrottleConfig.lockoutSeconds = 120;
    service = new LoginThrottleService(mockLogger as unknown as LoggerService);
  });

  describe('under the limit', () => {
    it('stays unlocked while failures are below maxAttempts', () => {
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 1_000);

      expect(service.check(IP, USER, 2_000)).toEqual({ locked: false });
    });

    it('keeps a separate budget per username on the same IP', () => {
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 1_000);
      service.recordFailure(IP, USER, 2_000);

      expect(service.check(IP, USER, 3_000).locked).toBe(true);
      // Someone else's guesses must not lock the owner's own account out.
      expect(service.check(IP, 'someone-else@example.com', 3_000)).toEqual({ locked: false });
    });

    it('keeps a separate budget per IP for the same username', () => {
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 1_000);
      service.recordFailure(IP, USER, 2_000);

      expect(service.check(IP, USER, 3_000).locked).toBe(true);
      // An attacker elsewhere must not be able to lock the owner out of their
      // own appliance from the owner's address.
      expect(service.check('198.51.100.4', USER, 3_000)).toEqual({ locked: false });
    });

    it('normalises the username so case and padding cannot buy a fresh budget', () => {
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, '  OWNER@example.com ', 1_000);
      service.recordFailure(IP, 'Owner@Example.com', 2_000);

      expect(service.check(IP, USER, 3_000).locked).toBe(true);
    });
  });

  describe('over the limit', () => {
    it('locks once maxAttempts failures land inside the window', () => {
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 1_000);
      service.recordFailure(IP, USER, 2_000);

      expect(service.check(IP, USER, 2_000)).toEqual({ locked: true, retryAfterSeconds: 120 });
    });

    it('reports the remaining lockout, rounded up and never zero', () => {
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 0);

      // 119.5s left → 120, and the final half-second still advertises 1.
      expect(service.check(IP, USER, 500)).toEqual({ locked: true, retryAfterSeconds: 120 });
      expect(service.check(IP, USER, 119_500)).toEqual({ locked: true, retryAfterSeconds: 1 });
    });

    it('unlocks when the lockout elapses, with a fresh budget rather than a hair trigger', () => {
      // All three at t=0, so the lockout runs 0 → 120_000 exactly.
      for (let i = 0; i < 3; i += 1) {
        service.recordFailure(IP, USER, 0);
      }

      expect(service.check(IP, USER, 119_000).locked).toBe(true);
      expect(service.check(IP, USER, 120_000)).toEqual({ locked: false });

      // The very next mistake must not re-lock: the counter was cleared when the
      // lockout began, so it takes another maxAttempts failures.
      service.recordFailure(IP, USER, 120_000);
      expect(service.check(IP, USER, 120_000)).toEqual({ locked: false });
      service.recordFailure(IP, USER, 121_000);
      expect(service.check(IP, USER, 121_000)).toEqual({ locked: false });
      service.recordFailure(IP, USER, 122_000);
      expect(service.check(IP, USER, 122_000).locked).toBe(true);
    });
  });

  describe('success resets', () => {
    it('clears the counter so earlier failures cannot combine into a lockout', () => {
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 1_000);

      service.recordSuccess(IP, USER);

      service.recordFailure(IP, USER, 2_000);
      service.recordFailure(IP, USER, 3_000);

      // Four failures total, but only two since the success.
      expect(service.check(IP, USER, 4_000)).toEqual({ locked: false });
      expect(trackedCount(service)).toBe(1);
    });

    it('only failures spend the budget', () => {
      for (let i = 0; i < 20; i += 1) {
        service.recordSuccess(IP, USER);
      }

      expect(service.check(IP, USER, 0)).toEqual({ locked: false });
      expect(trackedCount(service)).toBe(0);
    });
  });

  describe('window expiry', () => {
    it('starts a new window once the old one has run out', () => {
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 1_000);

      // 60s window from the first failure has ended, so this is failure #1 again.
      service.recordFailure(IP, USER, 61_000);
      service.recordFailure(IP, USER, 62_000);

      expect(service.check(IP, USER, 63_000)).toEqual({ locked: false });
    });

    it('prunes expired entries so the map cannot grow without bound', () => {
      for (let i = 0; i < 50; i += 1) {
        service.recordFailure(IP, `user-${i}@example.com`, 0);
      }

      expect(trackedCount(service)).toBe(50);

      // One failure past every window sweeps the lot on the way in.
      service.recordFailure(IP, 'late@example.com', 61_000);

      expect(trackedCount(service)).toBe(1);
    });
  });

  // Regression cover for the size ceiling. Keys are attacker-mintable — a fresh
  // username is a fresh key — so a ceiling enforced by evicting live counters is
  // one the attacker aims: flood the map until the counter that is about to lock
  // them out is the entry thrown away, and the lockout never arrives.
  describe('under a flood of minted identities', () => {
    it('keeps a counter the flood was aimed at, which still locks, and stays at the ceiling', () => {
      // Two failures banked before the flood: one short of the lockout.
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 0);

      floodIdentityMap(service, 0);

      expect(trackedCount(service)).toBe(MAX_TRACKED_IDENTITIES);
      // The counter that matters survived the flood, so the third failure locks.
      expect(service.check(IP, USER, 1_000)).toEqual({ locked: false });
      service.recordFailure(IP, USER, 1_000);
      expect(service.check(IP, USER, 1_000)).toEqual({ locked: true, retryAfterSeconds: 120 });
    });

    it('charges failures it cannot track to the client address instead', () => {
      floodIdentityMap(service, 0);

      // No slot left for a brand-new identity, so the budget applies per address
      // — stricter than per (address, username), never looser. Untracked would
      // hand the flooder unlimited guesses at the one password that matters.
      const attacker = '192.0.2.55';

      service.recordFailure(attacker, USER, 0);
      service.recordFailure(attacker, 'another@example.com', 0);
      expect(service.check(attacker, USER, 0)).toEqual({ locked: false });

      service.recordFailure(attacker, 'third@example.com', 0);

      expect(service.check(attacker, USER, 0)).toEqual({ locked: true, retryAfterSeconds: 120 });
      // Someone else's address is untouched by it, and the fallback is bounded.
      expect(service.check('192.0.2.99', USER, 0)).toEqual({ locked: false });
      // One bucket for the flood, one for this attacker — bounded by address.
      expect(sourceCount(service)).toBe(2);
    });

    it('clears an address budget on a successful login', () => {
      floodIdentityMap(service, 0);

      const owner = '192.0.2.55';

      service.recordFailure(owner, USER, 0);
      service.recordFailure(owner, USER, 0);

      service.recordSuccess(owner, USER);

      // A correct password proves this client is not the flood, so the two
      // typos that preceded it must not combine into a lockout.
      service.recordFailure(owner, USER, 0);
      service.recordFailure(owner, USER, 0);

      expect(service.check(owner, USER, 0)).toEqual({ locked: false });
    });
  });

  describe('disabled', () => {
    beforeEach(() => {
      mockLoginThrottleConfig.enabled = false;
    });

    it('never locks and records nothing', () => {
      for (let i = 0; i < 50; i += 1) {
        service.recordFailure(IP, USER, i);
      }

      expect(service.check(IP, USER, 100)).toEqual({ locked: false });
      expect(trackedCount(service)).toBe(0);
    });

    it('does not lock out on a budget that was spent before it was turned off', () => {
      mockLoginThrottleConfig.enabled = true;
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 0);
      service.recordFailure(IP, USER, 0);
      expect(service.check(IP, USER, 0).locked).toBe(true);

      mockLoginThrottleConfig.enabled = false;

      expect(service.check(IP, USER, 0)).toEqual({ locked: false });
    });
  });

  describe('fail-open', () => {
    // A throttle that throws must never be why an owner cannot reach their own
    // appliance, so every entry point swallows and logs instead of propagating.
    const bogusUsername = undefined as unknown as string;

    it('allows the attempt when check throws internally', () => {
      expect(service.check(IP, bogusUsername, 0)).toEqual({ locked: false });
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('swallows a failure it cannot record', () => {
      expect(() => service.recordFailure(IP, bogusUsername, 0)).not.toThrow();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('swallows a success it cannot clear', () => {
      expect(() => service.recordSuccess(IP, bogusUsername)).not.toThrow();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  it('tolerates a missing client IP rather than throwing on the login path', () => {
    service.recordFailure(undefined, USER, 0);
    service.recordFailure(undefined, USER, 0);
    service.recordFailure(undefined, USER, 0);

    expect(service.check(undefined, USER, 0).locked).toBe(true);
    // …and an unknown IP is its own bucket, not everyone's.
    expect(service.check(IP, USER, 0)).toEqual({ locked: false });
  });
});
