/**
 * "The database is not there right now" — told apart from "the database said no".
 *
 * The two look identical to a `catch` that only reads the message, and they
 * call for opposite responses. A constraint violation is about the ROW: retrying
 * it changes nothing, and quarantining it is the honest outcome. A server that
 * is restarting is about the WORLD: nothing is wrong with the row, the same
 * statement will succeed in a minute, and quarantining it turns a blip into a
 * permanent loss.
 *
 * That is not hypothetical. A Postgres crash-restart in the middle of a
 * 700k-row Takeout push answered every statement for a few seconds with
 * `the database system is in recovery mode` and then `the database system is
 * not yet accepting connections` (both SQLSTATE 57P03). The push's per-row
 * quarantine did exactly what it was built for with a poisoned record: it
 * marked 437 perfectly good rows `failed`, one by one, and moved on.
 *
 * ## Codes first, message second
 *
 * Classified on the SQLSTATE (or the Node socket code) wherever the driver
 * surfaced one, because a code is a contract and a message is prose that a
 * locale, a wrapper or a Postgres upgrade can reword. TypeORM puts the code on
 * the error itself or on `driverError` depending on which query path raised it
 * (the same reason `isDuplicateKey` and `isOutOfDiskError` check both), a
 * service may wrap the driver error in its own with `cause`, and Node's
 * multi-address connect raises an `AggregateError` whose members carry the
 * codes. All of those are walked.
 *
 * The message is consulted only when NOTHING in that chain carries a code —
 * `pg`'s own "Connection terminated unexpectedly" is a bare `Error`, and a
 * failure that crossed a string boundary (GraphIngestService reports each
 * failed entity as `entity <key>: <message>`) has only its text left. A chain
 * that does carry a code, and not a transient one, is decided by that code and
 * never by wording that happens to appear in it.
 *
 * ## Away before the statement ran, or gone down with it in flight
 *
 * "Transient" covers two different moments, and they differ in who could be to
 * blame. A server that is still in recovery (57P03) or refusing sockets
 * (ECONNREFUSED) never saw the statement: nothing about the statement can have
 * caused it, and waiting is the whole answer. A session the server ENDED
 * (57P01/57P02, "terminating connection …", pg's "Connection terminated
 * unexpectedly", a reset socket) had the statement in flight — and a statement
 * can crash a server. The precedent is a TimescaleDB 2.28 segfault during a
 * bulk upsert: every retry of that statement restarts the database again.
 *
 * {@link isDatabaseCrashError} names the second kind, and
 * {@link retryOnTransientDatabaseError} counts it when asked to
 * (`crashAttempts`): an operation in flight at that many crashes stops being
 * waited for and is raised as {@link DatabaseCrashedError}, which is NOT
 * transient — the caller's own isolation (the push's per-row quarantine) gets
 * to decide whether the operation, rather than the world, is the problem. A
 * wait for a server that was not yet taking statements never counts.
 */

/**
 * SQLSTATEs that mean the server could not take the statement, not that it
 * rejected it.
 *
 * Deliberately short. Serialization failures and deadlocks (40001, 40P01) are
 * retryable too, but they are about contention between writers, not about the
 * server being away, and the callers of this module decide what to do with the
 * ROW on the strength of the answer.
 */
export const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  /** admin_shutdown — "terminating connection due to administrator command". */
  '57P01',
  /** crash_shutdown — "terminating connection because of crash of another server process". */
  '57P02',
  /**
   * cannot_connect_now — "the database system is in recovery mode", "…is not
   * yet accepting connections", "…is starting up", "…is shutting down". The
   * code the incident above actually produced.
   */
  '57P03',
  /** connection_exception and its connection-level subclasses. */
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  /** too_many_connections — the server is up and full; a slot frees in seconds. */
  '53300',
]);

/** Socket-level codes a restarting server produces on the way down and back up. */
export const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * The wording, for errors that arrive with no code at all. Matched as
 * substrings, case-sensitively, exactly as the server and driver spell them.
 */
const TRANSIENT_MESSAGES: readonly string[] = [
  'the database system is in recovery mode',
  'the database system is not yet accepting connections',
  'the database system is starting up',
  'the database system is shutting down',
  'terminating connection due to administrator command',
  'terminating connection because of crash of another server process',
  // pg's Client, when the socket closes under a query in flight.
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  // pg-pool, when no connection could be established within connectionTimeoutMillis.
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error and is not queryable',
  'sorry, too many clients already',
  'remaining connection slots are reserved',
];

/** A Node socket code inside a message: `connect ECONNREFUSED 172.18.0.2:5432`. */
const NETWORK_CODE_IN_MESSAGE = new RegExp(`\\b(?:${[...TRANSIENT_NETWORK_CODES].join('|')})\\b`);

/**
 * The transient SQLSTATEs the server sends when it ENDS a session — so a
 * statement may have been running on it. A subset of {@link TRANSIENT_SQLSTATES}.
 *
 * 57P02 is what every OTHER backend is told when one backend crashes; the one
 * that crashed tells its client nothing, and the client sees its socket close
 * (see {@link CRASH_NETWORK_CODES} and {@link CRASH_MESSAGES}).
 */
export const CRASH_SQLSTATES: ReadonlySet<string> = new Set(['57P01', '57P02']);

/**
 * The socket code for a connection that was up and then went away under a
 * request. ECONNREFUSED/EHOSTUNREACH and friends are about connecting, i.e.
 * before any statement ran, and are deliberately not here; so is EPIPE, which
 * is OUR write failing — the statement did not reach the server.
 */
export const CRASH_NETWORK_CODES: ReadonlySet<string> = new Set(['ECONNRESET']);

/** The wording of the same, for a failure that arrives with no code. */
const CRASH_MESSAGES: readonly string[] = [
  'terminating connection due to administrator command',
  'terminating connection because of crash of another server process',
  'Connection terminated unexpectedly',
];

const CRASH_CODE_IN_MESSAGE = new RegExp(`\\b(?:${[...CRASH_NETWORK_CODES].join('|')})\\b`);

/**
 * A failure the caller KNOWS was transient but can no longer show a code for.
 *
 * The entity lane is the case: `GraphIngestService.ingest` catches a
 * batch-level failure and reports it per entity as text, so by the time the
 * push sees it the error object is gone. Wrapping that text in this class
 * states the verdict explicitly rather than re-deriving it at every layer.
 */
export class TransientDatabaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientDatabaseError';
  }
}

/**
 * The database stayed unavailable for longer than the caller was willing to
 * wait.
 *
 * A subclass of {@link TransientDatabaseError} because it IS one — nothing
 * about the work is wrong — and a caller deciding whether to quarantine a row
 * must still answer "no". What it changes is who retries: the caller gave up
 * waiting, so this is raised out to whatever can try again later (for an
 * import stage, the stage retry and the recovery sweep).
 */
export class DatabaseUnavailableError extends TransientDatabaseError {
  constructor(
    readonly operation: string,
    readonly attempts: number,
    readonly waitedMs: number,
    cause: unknown,
  ) {
    super(
      `the database was unavailable for ${Math.round(waitedMs / 1000)}s while ${operation} ` +
        `(${attempts} attempt(s); last error: ${describe(cause)})`,
      { cause },
    );
    this.name = 'DatabaseUnavailableError';
  }
}

/**
 * The database went down with this operation in flight, as many times as the
 * caller was willing to see that happen — so the operation itself is now a
 * suspect.
 *
 * Deliberately NOT a {@link TransientDatabaseError}, and
 * {@link isTransientDatabaseError} answers `false` for it even though its
 * `cause` carries a transient code. "Wait and send it again" is exactly what
 * must stop: if the statement is what crashes the server, every resend
 * restarts the whole appliance's database. Raised by
 * {@link retryOnTransientDatabaseError} only for a caller that set
 * `crashAttempts`, so that caller can isolate the work (the push degrades a
 * batch to single rows, and quarantines a single row) instead of looping.
 */
export class DatabaseCrashedError extends Error {
  constructor(
    readonly operation: string,
    readonly crashes: number,
    cause: unknown,
  ) {
    super(
      `the database went down ${crashes} time(s) with ${operation} in flight ` +
        `(last error: ${describe(cause)})`,
      { cause },
    );
    this.name = 'DatabaseCrashedError';
  }
}

/** Is this failure the database being away, rather than the database refusing? */
export function isTransientDatabaseError(err: unknown): boolean {
  const facts = collect(err);

  if (facts.verdict != null) {
    return facts.verdict === 'transient';
  }

  if (facts.codes.some(isTransientCode)) {
    return true;
  }

  if (facts.codes.length > 0) {
    return false;
  }

  return facts.messages.some(isTransientDatabaseMessage);
}

/**
 * Did the database end the session with a statement possibly IN FLIGHT —
 * crash, forced shutdown, reset socket — rather than refuse to take one?
 *
 * Always a subset of {@link isTransientDatabaseError}. Code-first by the same
 * rule: a chain that carries codes is decided by them (57P03 is "not yet
 * accepting connections", so never a crash), and only a chain with no code at
 * all is read for its wording. An error already given a verdict by class — a
 * {@link TransientDatabaseError} or a {@link DatabaseCrashedError} — is not
 * re-opened.
 */
export function isDatabaseCrashError(err: unknown): boolean {
  const facts = collect(err);

  if (facts.verdict != null) {
    return false;
  }

  if (facts.codes.length > 0) {
    return facts.codes.some((code) => CRASH_SQLSTATES.has(code) || CRASH_NETWORK_CODES.has(code));
  }

  return facts.messages.some(
    (message) =>
      CRASH_MESSAGES.some((needle) => message.includes(needle)) || CRASH_CODE_IN_MESSAGE.test(message),
  );
}

/**
 * The message-only half, for a failure that crossed a string boundary. Prefer
 * {@link isTransientDatabaseError} whenever an error object is still in hand.
 */
export function isTransientDatabaseMessage(message: string | null | undefined): boolean {
  if (message == null || message.length === 0) {
    return false;
  }

  return (
    TRANSIENT_MESSAGES.some((needle) => message.includes(needle)) || NETWORK_CODE_IN_MESSAGE.test(message)
  );
}

function isTransientCode(code: string): boolean {
  return TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NETWORK_CODES.has(code);
}

/** How deep a `cause` chain is followed. Real chains are two or three long. */
const MAX_CHAIN_DEPTH = 6;

/**
 * Every code and message in the error, its `driverError`, its `cause` chain and
 * an AggregateError's members — plus the verdict, if a link in it already
 * carries one by class.
 *
 * A verdict class ends the walk at that link: {@link DatabaseCrashedError}
 * wraps a transient `cause` precisely BECAUSE it has decided the failure is no
 * longer to be waited out, and reading through it to that cause would undo the
 * decision. The outermost verdict wins.
 */
function collect(err: unknown): { codes: string[]; messages: string[]; verdict: Verdict | null } {
  const codes: string[] = [];
  const messages: string[] = [];
  let verdict: Verdict | null = null;
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (
      verdict != null ||
      value == null ||
      typeof value !== 'object' ||
      depth > MAX_CHAIN_DEPTH ||
      seen.has(value)
    ) {
      return;
    }

    seen.add(value);

    if (value instanceof DatabaseCrashedError) {
      verdict = 'suspect';

      return;
    }

    if (value instanceof TransientDatabaseError) {
      verdict = 'transient';

      return;
    }

    const shaped = value as {
      code?: unknown;
      message?: unknown;
      driverError?: unknown;
      cause?: unknown;
      errors?: unknown;
    };

    if (typeof shaped.code === 'string' && shaped.code.length > 0) {
      codes.push(shaped.code);
    }

    if (typeof shaped.message === 'string') {
      messages.push(shaped.message);
    }

    visit(shaped.driverError, depth + 1);
    visit(shaped.cause, depth + 1);

    if (Array.isArray(shaped.errors)) {
      for (const member of shaped.errors) {
        visit(member, depth + 1);
      }
    }
  };

  visit(err, 0);

  return { codes, messages, verdict };
}

/**
 * What an error's CLASS already says about it: `transient` for a
 * {@link TransientDatabaseError} (wait, never quarantine), `suspect` for a
 * {@link DatabaseCrashedError} (stop waiting; the work may be the cause).
 */
type Verdict = 'transient' | 'suspect';

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return String(err);
}

// ---------------------------------------------------------------------------
// Waiting it out
// ---------------------------------------------------------------------------

/** How long, and how patiently, to wait for the database to come back. */
export interface TransientRetryPolicy {
  /** The first pause, in ms. Doubles per attempt. */
  initialDelayMs: number;
  /** No single pause is longer than this. */
  maxDelayMs: number;
  /**
   * Total time to keep trying, in ms, measured from the first failure. The
   * operation is not attempted again once the next pause would cross it.
   */
  budgetMs: number;
  /**
   * How many times the database may go down WITH THIS OPERATION IN FLIGHT
   * ({@link isDatabaseCrashError}) before the operation is suspected of taking
   * it down, and raised as {@link DatabaseCrashedError} instead of being sent
   * again. Waiting for a server that was not yet taking statements (57P03,
   * a refused socket) never counts toward it.
   *
   * Unset: every crash is waited out like any other outage. Right for a read or
   * a ledger UPDATE by id, which cannot plausibly be what crashes a server;
   * wrong for a bulk write of foreign data, which can.
   */
  crashAttempts?: number;
  /**
   * A pool of waiting time, in ms, that several calls SHARE. Every pause is
   * drawn from it, and no call pauses once the next pause would overdraw it —
   * so a caller running many operations against one outage (the push isolating
   * a batch row by row, each row meeting the same crash recovery) waits that
   * long in total, not `budgetMs` per operation. Mutated in place.
   */
  allowance?: { remainingMs: number };
  /** Injected in tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; defaults to `Date.now`. */
  now?: () => number;
}

/** What a caller is told each time the helper decides to wait and try again. */
export interface TransientRetryNotice {
  attempt: number;
  delayMs: number;
  waitedMs: number;
  /** Crashes counted against the operation so far — see `crashAttempts`. */
  crashes: number;
  error: unknown;
}

/**
 * Run `op`, and when it fails because the database is away, wait and run it
 * again — until it succeeds, fails for a reason that is not transient, the
 * budget is spent, or (with `crashAttempts`) the database has gone down with it
 * in flight too many times.
 *
 * - A non-transient failure is rethrown untouched on the attempt it happened,
 *   so a caller's own handling (quarantine the row, dedup on 23505, stop on
 *   53100) sees exactly what it always saw.
 * - A transient failure that outlasts the budget (or the shared `allowance`)
 *   is rethrown as {@link DatabaseUnavailableError}, with the last error as its
 *   `cause`.
 * - The `crashAttempts`-th crash with `op` in flight is rethrown as
 *   {@link DatabaseCrashedError}, which is not transient — see its doc.
 *
 * `op` must be safe to repeat. That is the caller's promise, not something this
 * can check — and "safe" means "repeats land on the same rows", which each
 * destination earns its own way. For the import push: most destinations upsert
 * on the provenance triple (source_system, source_id, source_type); `position`
 * has no triple and dedupes by timestamp (`PositionService` skips a time it
 * already holds); `receipts` upserts its header on the triple and its lines on
 * `(receipt_id, line_number)`, one transaction per receipt. The ledger writes
 * are UPDATEs by row id. A new destination that has none of these is not safe
 * to hand to this until it does.
 */
export async function retryOnTransientDatabaseError<T>(
  operation: string,
  op: (attempt: number) => Promise<T>,
  policy: TransientRetryPolicy,
  onRetry?: (notice: TransientRetryNotice) => void,
): Promise<T> {
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = policy.now ?? (() => Date.now());

  let firstFailureAt: number | null = null;
  let delayMs = Math.max(0, policy.initialDelayMs);
  let crashes = 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await op(attempt);
    } catch (err) {
      if (err instanceof DatabaseUnavailableError || !isTransientDatabaseError(err)) {
        // A nested helper already gave up — waiting again here would multiply
        // the budget rather than respect it. (A DatabaseCrashedError is not
        // transient, so a nested verdict of that kind goes straight up too.)
        throw err;
      }

      if (policy.crashAttempts != null && isDatabaseCrashError(err)) {
        crashes += 1;

        if (crashes >= policy.crashAttempts) {
          throw new DatabaseCrashedError(operation, crashes, err);
        }
      }

      firstFailureAt ??= now();

      const waitedMs = now() - firstFailureAt;
      const overdrawn = policy.allowance != null && delayMs > policy.allowance.remainingMs;

      if (overdrawn || waitedMs + delayMs > policy.budgetMs) {
        throw new DatabaseUnavailableError(operation, attempt, waitedMs, err);
      }

      onRetry?.({ attempt, delayMs, waitedMs, crashes, error: err });

      if (policy.allowance != null) {
        policy.allowance.remainingMs -= delayMs;
      }

      await sleep(delayMs);

      delayMs = Math.min(Math.max(1, delayMs * 2), policy.maxDelayMs);
    }
  }
}
