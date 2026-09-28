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

/** Is this failure the database being away, rather than the database refusing? */
export function isTransientDatabaseError(err: unknown): boolean {
  const facts = collect(err);

  if (facts.marked || facts.codes.some(isTransientCode)) {
    return true;
  }

  if (facts.codes.length > 0) {
    return false;
  }

  return facts.messages.some(isTransientDatabaseMessage);
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
 * an AggregateError's members — plus whether anything in it was already
 * declared transient by class.
 */
function collect(err: unknown): { codes: string[]; messages: string[]; marked: boolean } {
  const codes: string[] = [];
  const messages: string[] = [];
  let marked = false;
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (value == null || typeof value !== 'object' || depth > MAX_CHAIN_DEPTH || seen.has(value)) {
      return;
    }

    seen.add(value);

    if (value instanceof TransientDatabaseError) {
      marked = true;
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

  return { codes, messages, marked };
}

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
  error: unknown;
}

/**
 * Run `op`, and when it fails because the database is away, wait and run it
 * again — until it succeeds, fails for a reason that is not transient, or the
 * budget is spent.
 *
 * - A non-transient failure is rethrown untouched on the attempt it happened,
 *   so a caller's own handling (quarantine the row, dedup on 23505, stop on
 *   53100) sees exactly what it always saw.
 * - A transient failure that outlasts the budget is rethrown as
 *   {@link DatabaseUnavailableError}, with the last error as its `cause`.
 *
 * `op` must be safe to repeat. That is the caller's promise, not something this
 * can check: every write the import push makes upserts on its provenance
 * triple, which is what makes it true there.
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

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await op(attempt);
    } catch (err) {
      if (err instanceof DatabaseUnavailableError || !isTransientDatabaseError(err)) {
        // A nested helper already gave up — waiting again here would multiply
        // the budget rather than respect it.
        throw err;
      }

      firstFailureAt ??= now();

      const waitedMs = now() - firstFailureAt;

      if (waitedMs + delayMs > policy.budgetMs) {
        throw new DatabaseUnavailableError(operation, attempt, waitedMs, err);
      }

      onRetry?.({ attempt, delayMs, waitedMs, error: err });

      await sleep(delayMs);

      delayMs = Math.min(Math.max(1, delayMs * 2), policy.maxDelayMs);
    }
  }
}
