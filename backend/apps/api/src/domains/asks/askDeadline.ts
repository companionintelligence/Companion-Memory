/**
 * Every ask gets a deadline, and the deadline cannot be removed.
 *
 * ═══ `expires_at` HAD THREE READERS AND NO WRITER ═══
 *
 * `ci.asks.expires_at` is read by `AskExpiryService.sweep` (the `LessThan(now)`
 * scan), by `AskType.expiresAt`, and by the `answering → expired` edge added to
 * the state machine for it. Nothing ever WROTE one: `AskService.create` took
 * `data.expiresAt` with a `?? null` fallback and no caller in the codebase
 * passed the field — verified against a live harness, where 0 of 53 asks
 * carried a deadline. A NULL never satisfies a SQL comparison, so the sweep
 * scanned, matched nothing, and logged nothing, on every box, forever.
 *
 * `AskExpiryService`'s own docstring names the consequence, and it is not
 * cosmetic: an ask sitting in `answering` is answerable by definition
 * ({@link isAnswerable}), and `AskService.complete` deliberately does NOT
 * re-check the standing grant on the owner-approved path — that human decision
 * is not undone by revoking an unrelated grant. An approved ask with no
 * deadline is therefore "a permanent, revocation-immune authorization to
 * disclose in full". The sweep was built to end that state and could not reach
 * a single row.
 *
 * ═══ WHY THE TTL CANNOT BE TURNED OFF ═══
 *
 * The knob below is a DURATION, not an enable/disable. An operator can make
 * asks live longer or shorter; they cannot make one live forever, and neither
 * can a caller — {@link defaultAskExpiry} is applied to any nullish
 * `expiresAt`, so an explicit `null` means "give me the default", not "no
 * deadline". A path that could opt out is the path that reintroduces the
 * revocation-immune authorization above, and there is no ask in this domain
 * that benefits from outliving the owner's attention.
 */

/**
 * How long an ask stays live when nothing says otherwise.
 *
 * Three days rather than three hours: the whole point of the review inbox is
 * that a human answers it when they get to it, and a deadline short enough to
 * retire asks before the owner opens the app turns every ask into an expiry.
 * Three days rather than three weeks: the ask is an open authorization for
 * exactly as long as it is unanswered, and "I meant to look at that" is not
 * consent.
 *
 * The number is a default, not a policy — see {@link ASK_TTL_HOURS_ENV_VAR}.
 */
export const DEFAULT_ASK_TTL_HOURS = 72;

/** The operator override. Hours, positive, finite. */
export const ASK_TTL_HOURS_ENV_VAR = 'ASK_DEFAULT_TTL_HOURS';

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The configured TTL in hours, or the default.
 *
 * ANYTHING UNREADABLE FALLS BACK TO THE DEFAULT rather than to "no expiry".
 * That is the whole shape of the fix: a typo, an empty string, a `0`, a
 * negative, an `Infinity` or a `NaN` all mean the operator did not successfully
 * express a duration, and the fail-closed reading of "no duration" is the
 * built-in one — never an unbounded ask. A `0` in particular reads as an
 * attempt to disable the sweep, which is the one thing this knob may not do.
 *
 * `env` is a parameter so the behaviour is testable without mutating the
 * process environment underneath a parallel test worker.
 */
export function askTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ASK_TTL_HOURS_ENV_VAR];

  if (raw == null || raw.trim() === '') {
    return DEFAULT_ASK_TTL_HOURS;
  }

  const parsed = Number(raw);

  // `Number.isFinite` rejects NaN and both infinities; `> 0` rejects zero and
  // negatives, which would put the deadline in the past and expire every ask on
  // the next sweep.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASK_TTL_HOURS;
}

/**
 * The deadline to stamp on an ask created at `now`.
 *
 * Pure given its arguments — `now` and `env` are both injectable so the
 * boundary is testable without moving the system clock.
 */
export function defaultAskExpiry(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Date {
  return new Date(now.getTime() + askTtlHours(env) * MS_PER_HOUR);
}
