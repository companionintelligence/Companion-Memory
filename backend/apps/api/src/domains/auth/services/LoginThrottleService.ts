import { createHmac } from 'crypto';

import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

/**
 * Ceiling on how many distinct identities are tracked at once. An attacker can
 * mint a fresh key per request by varying the submitted username, so without a
 * bound the map is a remote memory-exhaustion primitive. 10k entries is a few
 * MB and is far beyond anything a single-account appliance produces honestly.
 */
const MAX_TRACKED_IDENTITIES = 10_000;

/**
 * Ceiling on the per-source buckets that catch failures while the identity map
 * is full (see {@link LoginThrottleService.recordFailure}). One entry per client
 * address, so it only fills under a flood from a thousand addresses — at which
 * point a per-address budget is not what is holding the attacker back anyway.
 */
const MAX_TRACKED_SOURCES = 1_024;

type Attempt = {
  /** Failures counted so far inside the current window. */
  failures: number;
  /** ms epoch at which the rolling window (and hence this entry) expires. */
  windowEndsAt: number;
  /** ms epoch until which attempts are refused outright; 0 while under budget. */
  lockedUntil: number;
};

/** What one counted failure did: `untracked` means the store was full. */
type CountOutcome = 'counted' | 'locked' | 'untracked';

export type ThrottleStatus = { locked: false } | { locked: true; retryAfterSeconds: number };

const NOT_LOCKED: ThrottleStatus = { locked: false };

/**
 * Failed-password throttle for the local login route.
 *
 * The appliance is one account behind one password on a box its owner may have
 * exposed to a tailnet or the internet (the publish manifest marks it
 * internet-exposable), and nothing else on the login path limited guesses — so
 * unlimited attempts against that single password *was* the attack.
 *
 * Shape of the budget: `maxAttempts` failures per (client IP, username) inside
 * `windowSeconds`, then attempts are refused for `lockoutSeconds`. Keying on the
 * pair rather than on the username alone means one attacker cannot lock the
 * owner out from a different address, and keying on it rather than on the IP
 * alone means a shared NAT does not pool everyone's mistakes together.
 *
 * State is in-memory and therefore per-process, which is correct for the
 * single-instance appliance deployment (same reasoning as
 * {@link OidcNativeCodeService}); a horizontally scaled deployment would need
 * this in a shared store to keep the budget global.
 *
 * Every public method is fail-OPEN: a throttle that throws must never be the
 * reason an owner cannot reach their own appliance, so an internal error here
 * lets the login proceed and is logged rather than surfaced.
 */
@Injectable()
export class LoginThrottleService {
  private readonly attempts = new Map<string, Attempt>();

  /**
   * Per-client-address budgets, written only while {@link attempts} is full.
   * Empty in normal operation.
   */
  private readonly sources = new Map<string, Attempt>();

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(LoginThrottleService.name);
  }

  /**
   * Whether this identity is currently locked out. `now` is injectable so tests
   * can drive the clock rather than sleep.
   */
  check(ip: string | undefined, username: string, now: number = Date.now()): ThrottleStatus {
    try {
      if (!config.auth.loginThrottle.enabled) {
        return NOT_LOCKED;
      }

      // Read-only: the read path deliberately never sweeps, so `check` can never
      // change what a later `recordFailure` counts.
      const identity = this.statusOf(this.attempts.get(this.identify(ip, username)), now);

      if (identity.locked || this.sources.size === 0) {
        return identity;
      }

      // A lockout this address earned while the identity map was full still
      // applies — see `recordFailure`. The size check above keeps normal
      // operation, where that map is empty, one HMAC per attempt as before.
      return this.statusOf(this.sources.get(this.identifySource(ip)), now);
    } catch (error) {
      this.logger.error(`Login throttle check failed, allowing the attempt: ${String(error)}`);

      return NOT_LOCKED;
    }
  }

  /** Count one failed password attempt against this identity. */
  recordFailure(ip: string | undefined, username: string, now: number = Date.now()): void {
    try {
      const { enabled, maxAttempts, lockoutSeconds } = config.auth.loginThrottle;

      if (!enabled) {
        return;
      }

      const key = this.identify(ip, username);

      // Sweep before the write, and never at this key's expense: the counter
      // being spent here is exempt from the sweep, so neither the ordering of
      // prune-vs-read nor pressure from other identities can reset it.
      this.prune(this.attempts, now, key);

      let outcome = this.countFailure(this.attempts, key, MAX_TRACKED_IDENTITIES, now);

      if (outcome === 'untracked') {
        // The identity map is full of *live* counters, which only a flood of
        // distinct usernames produces. Making room by evicting one of them is
        // precisely what the flood would be for, so instead the failure is
        // charged to the client address: the flooder pays for its own noise out
        // of a budget it cannot mint a fresh copy of, and every identity already
        // being counted keeps its counter and still locks. The cost is that
        // while saturated, a brand-new identity is throttled per address rather
        // than per (address, username) — stricter, never looser.
        const sourceKey = this.identifySource(ip);

        this.prune(this.sources, now, sourceKey);

        outcome = this.countFailure(this.sources, sourceKey, MAX_TRACKED_SOURCES, now);
      }

      if (outcome === 'locked') {
        this.logger.warn(
          `Login throttle engaged for ${lockoutSeconds}s after ${maxAttempts} failed attempts (ip=${ip ?? 'unknown'})`,
        );
      }
    } catch (error) {
      this.logger.error(`Login throttle failed to record a failure: ${String(error)}`);
    }
  }

  /** Clear this identity's budget. Only failures count toward the limit. */
  recordSuccess(ip: string | undefined, username: string): void {
    try {
      this.attempts.delete(this.identify(ip, username));
      // The address bucket goes too: a correct password is proof this client is
      // not the flood that bucket exists to charge.
      this.sources.delete(this.identifySource(ip));
    } catch (error) {
      this.logger.error(`Login throttle failed to clear a counter: ${String(error)}`);
    }
  }

  /**
   * Count one failure against `key` in `store`, keeping the store at or under
   * `ceiling`.
   *
   * Returns `untracked` when `key` has no entry and the store is already at the
   * ceiling. Room is never made by evicting a live counter: keys are
   * attacker-mintable (any username is a new one), so *any* eviction policy over
   * live counters is one the attacker aims — flood until the counter that
   * matters is the one thrown away, and the lockout never arrives. Declining to
   * track a brand-new identity is the only bound that cannot be pointed at an
   * existing counter.
   */
  private countFailure(store: Map<string, Attempt>, key: string, ceiling: number, now: number): CountOutcome {
    const { maxAttempts, windowSeconds, lockoutSeconds } = config.auth.loginThrottle;
    const entry = store.get(key);

    if (entry == null && store.size >= ceiling) {
      return 'untracked';
    }

    // A counter whose window has run out starts over rather than accumulating
    // across hours of unrelated typos.
    const current = entry && now < entry.windowEndsAt ? entry : null;
    const failures = (current?.failures ?? 0) + 1;

    if (failures >= maxAttempts) {
      const lockedUntil = now + lockoutSeconds * 1000;

      // Spending the budget both starts the lockout and clears the counter, so
      // when the lockout ends the identity gets a whole fresh budget instead of
      // being re-locked by its very next mistake. The owner is behind this same
      // throttle, and a lockout that a single typo renews is an outage.
      store.set(key, { failures: 0, windowEndsAt: lockedUntil, lockedUntil });

      return 'locked';
    }

    store.set(key, {
      failures,
      windowEndsAt: current?.windowEndsAt ?? now + windowSeconds * 1000,
      lockedUntil: current?.lockedUntil ?? 0,
    });

    return 'counted';
  }

  /** Lockout status an entry reports at `now`. */
  private statusOf(entry: Attempt | undefined, now: number): ThrottleStatus {
    if (entry == null || entry.lockedUntil <= now) {
      return NOT_LOCKED;
    }

    return {
      locked: true,
      // Round up, and never advertise 0 — a Retry-After of 0 invites an
      // immediate retry that is still inside the lockout.
      retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)),
    };
  }

  /**
   * Key an attempt by client IP + username. The IP comes from the caller (which
   * reads it through `AuthService.getSessionMetadata`, i.e. Express's `req.ip`
   * under the app's configured proxy trust) — deliberately NOT from a raw
   * X-Forwarded-For read here, which an attacker could vary per request to get
   * a fresh budget every guess.
   *
   * Peppered rather than stored raw: this is the same treatment sessions give
   * `ip`/`user_agent`, and the username field of a failed login is exactly where
   * a mistyped password ends up.
   */
  private identify(ip: string | undefined, username: string): string {
    return createHmac('sha256', config.auth.session.fieldPepper)
      .update(`${ip ?? 'unknown'} ${username.trim().toLowerCase()}`)
      .digest('hex');
  }

  /** Address-only key for the saturation buckets; peppered for the same reason. */
  private identifySource(ip: string | undefined): string {
    return createHmac('sha256', config.auth.session.fieldPepper)
      .update(`source ${ip ?? 'unknown'}`)
      .digest('hex');
  }

  /**
   * Drop entries whose window *and* lockout have both elapsed. Entries are swept
   * lazily on the only path that grows a store, and `exempt` — the identity the
   * caller is about to count — is never swept, so a sweep can never be the reason
   * a counter reads as absent (the caller overwrites that entry immediately).
   *
   * Nothing still live is evicted, so this cannot pull a saturated store back
   * under its ceiling on its own. That is deliberate: `countFailure` enforces the
   * ceiling at insertion instead, where an attacker cannot aim it.
   */
  private prune(store: Map<string, Attempt>, now: number, exempt: string): void {
    for (const [key, entry] of store) {
      if (key !== exempt && now >= entry.windowEndsAt && now >= entry.lockedUntil) {
        store.delete(key);
      }
    }
  }
}
