import { createHmac } from 'crypto';
import { isIPv4, isIPv6 } from 'net';

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

/**
 * Ceiling on per-account budgets. Only usernames that name an account get one,
 * so a flood of made-up names cannot fill this map; the bound is for safety.
 */
const MAX_TRACKED_ACCOUNTS = 1_024;

/**
 * Failures one account absorbs, from every address together, before each further
 * attempt on it has to wait. Generous enough that a household's typos never meet it.
 */
const ACCOUNT_FREE_FAILURES = 10;

/**
 * How fast an account's failure count drains: one failure forgiven per interval.
 * A count, not a window, so pausing until a window rolls over does not hand an
 * attacker a fresh allowance; it buys back one failure per interval, which is
 * also the sustained rate the delay below settles at.
 */
const ACCOUNT_LEAK_MS = 3 * 60 * 1000;

/** Longest wait between attempts on one account. Equal to the leak interval, see above. */
const ACCOUNT_MAX_DELAY_SECONDS = 180;

/**
 * Failures across the whole appliance, inside one `windowSeconds`, past which it
 * is treated as under attack: every account then waits from its first failure
 * instead of after {@link ACCOUNT_FREE_FAILURES}. An honest appliance sees a few
 * a day. Nobody is refused outright on account of the global rate, so a flood
 * cannot lock the owner out of every account at once; it only takes away the
 * free allowance.
 */
const GLOBAL_PRESSURE_FAILURES = 100;

/**
 * Retry-After for an attempt refused because both tracking maps are full of live
 * entries and it would need a new one in each. Admitting it uncounted, as this
 * used to, gave every address that arrived after the maps filled unlimited
 * guesses for as long as the flood kept them full.
 */
const SATURATED_RETRY_SECONDS = 60;

type Attempt = {
  /** Failures counted so far inside the current window. */
  failures: number;
  /** ms epoch at which the rolling window (and hence this entry) expires. */
  windowEndsAt: number;
  /** ms epoch until which attempts are refused outright; 0 while under budget. */
  lockedUntil: number;
};

type AccountBudget = {
  /** Failures not yet drained, as of `updatedAt`. */
  level: number;
  /** ms epoch `level` was last written. */
  updatedAt: number;
  /** ms epoch before which the next attempt on this account is refused. */
  nextAllowedAt: number;
};

/** What one counted failure did: `untracked` means the store was full. */
type CountOutcome = 'counted' | 'locked' | 'untracked';

export type ThrottleStatus = { locked: false } | { locked: true; retryAfterSeconds: number };

const NOT_LOCKED: ThrottleStatus = { locked: false };

/**
 * The part of a client address the throttle keys on. IPv4 addresses (including
 * IPv4-mapped IPv6 ones) as they are; IPv6 addresses by their /64, the smallest
 * block a home or hosting customer is handed. Keying each IPv6 address on its own
 * gave anyone with one such block 2^64 fresh budgets.
 */
export function throttleSourceOf(ip: string | undefined): string {
  if (!ip) {
    return 'unknown';
  }

  const address = ip.trim().split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);

  if (mapped && isIPv4(mapped[1])) {
    return mapped[1];
  }

  if (!isIPv6(address)) {
    return address;
  }

  const groups = expandIPv6(address);

  return groups ? `${groups.slice(0, 4).join(':')}::/64` : address;
}

/** The eight 16-bit groups of a valid IPv6 address, lower-case hex without leading zeros. */
function expandIPv6(address: string): string[] | null {
  let text = address.toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);

  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);

    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');

  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tail];

  return groups.length === 8 ? groups.map((group) => parseInt(group, 16).toString(16)) : null;
}

/**
 * Failed-password throttle for the local login route.
 *
 * The appliance is one account behind one password on a box its owner may have
 * exposed to a tailnet or the internet (the publish manifest marks it
 * internet-exposable), and nothing else on the login path limited guesses — so
 * unlimited attempts against that single password *was* the attack.
 *
 * Three budgets, each catching what the others cannot:
 *
 * - Per (client address, username): `maxAttempts` failures inside
 *   `windowSeconds`, then refused for `lockoutSeconds`. Keying on the pair
 *   rather than on the username alone means one attacker cannot lock the owner
 *   out from a different address, and keying on it rather than on the IP alone
 *   means a shared NAT does not pool everyone's mistakes together. IPv6
 *   addresses count by /64 ({@link throttleSourceOf}).
 * - Per account, from every address together: after
 *   {@link ACCOUNT_FREE_FAILURES} failures, each further attempt has to wait,
 *   twice as long each time up to {@link ACCOUNT_MAX_DELAY_SECONDS}. Never a
 *   hard lock: the right password still works once the wait is over, so an
 *   attacker can slow the owner down but not shut them out. This is what stops
 *   an attacker with many addresses, which the first budget alone did not.
 * - Appliance-wide: past {@link GLOBAL_PRESSURE_FAILURES} failures in a window
 *   the free allowance above drops to nothing.
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

  /** Per-account budgets, across every address. Only real accounts get one. */
  private readonly accounts = new Map<string, AccountBudget>();

  /** When the current appliance-wide window ends. */
  private globalWindowEndsAt = 0;

  /** Failures across the appliance in the current window. */
  private globalFailures = 0;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(LoginThrottleService.name);
  }

  /**
   * Whether this identity may try now. `now` is injectable so tests can drive
   * the clock rather than sleep.
   */
  check(ip: string | undefined, username: string, now: number = Date.now()): ThrottleStatus {
    try {
      if (!config.auth.loginThrottle.enabled) {
        return NOT_LOCKED;
      }

      const identityKey = this.identify(ip, username);
      const identity = this.statusOf(this.attempts.get(identityKey), now);

      if (identity.locked) {
        return identity;
      }

      const account = this.accountStatus(this.accounts.get(this.identifyAccount(username)), now);

      if (account.locked) {
        return account;
      }

      // A lockout this address earned while the identity map was full still
      // applies — see `recordFailure`. The size check keeps normal operation,
      // where that map is empty, free of the extra HMAC.
      const sourceKey = this.sources.size === 0 ? null : this.identifySource(ip);

      if (sourceKey != null) {
        const source = this.statusOf(this.sources.get(sourceKey), now);

        if (source.locked) {
          return source;
        }
      }

      return this.saturated(identityKey, () => sourceKey ?? this.identifySource(ip), now)
        ? { locked: true, retryAfterSeconds: SATURATED_RETRY_SECONDS }
        : NOT_LOCKED;
    } catch (error) {
      this.logger.error(`Login throttle check failed, allowing the attempt: ${String(error)}`);

      return NOT_LOCKED;
    }
  }

  /**
   * Count one failed password attempt against this identity.
   *
   * @param accountExists whether `username` names an account. Only those get a per-account
   *   budget: a made-up name has nothing to protect, and tracking every one would let a flood of
   *   them fill the map.
   */
  recordFailure(
    ip: string | undefined,
    username: string,
    now: number = Date.now(),
    { accountExists = false }: { accountExists?: boolean } = {},
  ): void {
    try {
      const { enabled, maxAttempts, lockoutSeconds } = config.auth.loginThrottle;

      if (!enabled) {
        return;
      }

      this.countGlobal(now);

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

      if (accountExists) {
        this.countAccountFailure(username, now);
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
      // And the account's: whoever knows the password is the person it protects.
      this.accounts.delete(this.identifyAccount(username));
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
   * existing counter; {@link check} refuses the attempt that would need it.
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

  /** Charge one failure to the account `username` names, and set how long its next attempt waits. */
  private countAccountFailure(username: string, now: number): void {
    const key = this.identifyAccount(username);

    this.pruneAccounts(now, key);

    const entry = this.accounts.get(key);

    if (entry == null && this.accounts.size >= MAX_TRACKED_ACCOUNTS) {
      return;
    }

    const level = this.drained(entry, now) + 1;
    const free = this.underPressure(now) ? 0 : ACCOUNT_FREE_FAILURES;
    const excess = Math.ceil(level - free);
    const delaySeconds = excess > 0 ? Math.min(2 ** (excess - 1), ACCOUNT_MAX_DELAY_SECONDS) : 0;

    this.accounts.set(key, { level, updatedAt: now, nextAllowedAt: now + delaySeconds * 1000 });

    if (excess === 1) {
      this.logger.warn('Login throttle is spacing out attempts on an account after repeated failures');
    }
  }

  /** An account budget's failure count at `now`, after draining. */
  private drained(entry: AccountBudget | undefined, now: number): number {
    if (entry == null) {
      return 0;
    }

    return Math.max(0, entry.level - (now - entry.updatedAt) / ACCOUNT_LEAK_MS);
  }

  private accountStatus(entry: AccountBudget | undefined, now: number): ThrottleStatus {
    if (entry == null || entry.nextAllowedAt <= now) {
      return NOT_LOCKED;
    }

    return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.nextAllowedAt - now) / 1000)) };
  }

  private countGlobal(now: number): void {
    if (now >= this.globalWindowEndsAt) {
      this.globalWindowEndsAt = now + config.auth.loginThrottle.windowSeconds * 1000;
      this.globalFailures = 0;
    }

    this.globalFailures += 1;

    if (this.globalFailures === GLOBAL_PRESSURE_FAILURES) {
      this.logger.warn(
        `Login throttle: ${GLOBAL_PRESSURE_FAILURES} failed logins this window; every account now waits from its first failure`,
      );
    }
  }

  private underPressure(now: number): boolean {
    return now < this.globalWindowEndsAt && this.globalFailures > GLOBAL_PRESSURE_FAILURES;
  }

  /**
   * Whether this attempt would need a new entry in two stores that are both full of live
   * ones. Expired entries are swept first, so a flood that has ended frees the slots it held.
   */
  private saturated(identityKey: string, source: () => string, now: number): boolean {
    if (this.attempts.size < MAX_TRACKED_IDENTITIES || this.attempts.has(identityKey)) {
      return false;
    }

    this.prune(this.attempts, now, identityKey);

    if (this.attempts.size < MAX_TRACKED_IDENTITIES) {
      return false;
    }

    // Only now: the address key costs an HMAC, and a store with room never needs it.
    const sourceKey = source();

    this.prune(this.sources, now, sourceKey);

    return this.sources.size >= MAX_TRACKED_SOURCES && !this.sources.has(sourceKey);
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
   * Key an attempt by client address + username. The IP comes from the caller
   * (which reads it through `AuthService.getSessionMetadata`, i.e. Express's
   * `req.ip` under the app's configured proxy trust) — deliberately NOT from a
   * raw X-Forwarded-For read here, which an attacker could vary per request to
   * get a fresh budget every guess.
   *
   * Peppered rather than stored raw: this is the same treatment sessions give
   * `ip`/`user_agent`, and the username field of a failed login is exactly where
   * a mistyped password ends up.
   */
  private identify(ip: string | undefined, username: string): string {
    return createHmac('sha256', config.auth.session.fieldPepper)
      .update(`${throttleSourceOf(ip)} ${username.trim().toLowerCase()}`)
      .digest('hex');
  }

  /** Address-only key for the saturation buckets; peppered for the same reason. */
  private identifySource(ip: string | undefined): string {
    return createHmac('sha256', config.auth.session.fieldPepper)
      .update(`source ${throttleSourceOf(ip)}`)
      .digest('hex');
  }

  /** Username-only key for the per-account budgets; peppered for the same reason. */
  private identifyAccount(username: string): string {
    return createHmac('sha256', config.auth.session.fieldPepper)
      .update(`account ${username.trim().toLowerCase()}`)
      .digest('hex');
  }

  /**
   * Drop entries whose window *and* lockout have both elapsed. Entries are swept
   * lazily on the paths that grow a store, and `exempt` — the identity the
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

  /** Drop account budgets that have drained to nothing and impose no wait. */
  private pruneAccounts(now: number, exempt: string): void {
    for (const [key, entry] of this.accounts) {
      if (key !== exempt && now >= entry.nextAllowedAt && this.drained(entry, now) === 0) {
        this.accounts.delete(key);
      }
    }
  }
}
