/**
 * Per-user, per-browser memory of "this person just finished onboarding and the
 * getting-started banner should be up".
 *
 * localStorage on purpose. It is a convenience, not a fact about the account:
 * the banner is a first-session nudge, so losing it (cleared storage, a second
 * browser) costs one banner, and keeping it on the server would mean a table
 * and a migration to remember that someone once closed a strip of UI. Every
 * access is wrapped because storage can throw (private windows, blocked site
 * data) and the shell must render either way.
 *
 * Marked ACTIVE by the onboarding submit, not inferred from an empty account:
 * inferring it would put the banner in front of everyone who onboarded before
 * it existed, and of anyone who has genuinely chosen to keep an empty memory.
 */

const KEY_PREFIX = 'ci:getting-started:';

/** A banner nobody closed still goes away; a first-run nudge is not permanent chrome. */
export const GETTING_STARTED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type Stored = { state: 'active' | 'dismissed'; since: string };

function read(userId: string): Stored | null {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + userId);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<Stored> | null;

    if (
      parsed &&
      (parsed.state === 'active' || parsed.state === 'dismissed') &&
      typeof parsed.since === 'string'
    ) {
      return { state: parsed.state, since: parsed.since };
    }
  } catch {
    // Unreadable or unavailable storage reads as "never marked".
  }

  return null;
}

function write(userId: string, value: Stored): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + userId, JSON.stringify(value));
  } catch {
    // Not remembering is fine: the banner is a nudge, not state.
  }
}

/** Called once, when onboarding succeeds. */
export function markGettingStartedActive(userId: string, now: Date = new Date()): void {
  write(userId, { state: 'active', since: now.toISOString() });
}

export function dismissGettingStarted(userId: string, now: Date = new Date()): void {
  write(userId, { state: 'dismissed', since: now.toISOString() });
}

/** Is the banner owed to this user right now? */
export function isGettingStartedActive(userId: string | null | undefined, now: Date = new Date()): boolean {
  if (!userId) {
    return false;
  }

  const stored = read(userId);

  if (stored?.state !== 'active') {
    return false;
  }

  const since = Date.parse(stored.since);

  return Number.isFinite(since) && now.getTime() - since < GETTING_STARTED_MAX_AGE_MS;
}
