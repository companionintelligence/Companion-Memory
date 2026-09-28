/**
 * "The database is not there right now" — told apart from "the database said no".
 *
 * The two look identical to a `catch` that only reads the message, and they
 * call for opposite responses. A constraint violation is about the ROW: retrying
 * it changes nothing, and quarantining it is the honest outcome. A server that
 * is restarting is about the WORLD: nothing is wrong with the row, and
 * quarantining it turns a blip into a permanent loss.
 *
 * That is not hypothetical. A Postgres crash-restart in the middle of a
 * 700k-row Takeout push answered every statement for a few seconds with
 * `the database system is in recovery mode` and then `the database system is
 * not yet accepting connections` (both SQLSTATE 57P03). The push's per-row
 * quarantine did exactly what it was built for with a poisoned record: it
 * marked 437 perfectly good rows `failed`, one by one, and moved on.
 *
 * ## Not ready, or crashed with the statement in flight
 *
 * "The database is away" is two different moments, and only one of them may
 * be answered by sending the statement again.
 *
 * - **Not ready** ({@link isDatabaseNotReadyError}): the server never took the
 *   statement. It is still in recovery or starting up (57P03), full (53300),
 *   refusing or unreachable at the socket (ECONNREFUSED, EHOSTUNREACH,
 *   ENETUNREACH, a `connect` ETIMEDOUT, a DNS EAI_AGAIN), or the pool could not
 *   hand out a connection in time. Nothing about the statement can have caused
 *   that, and waiting is the whole answer: {@link retryOnTransientDatabaseError}
 *   waits and sends it again.
 * - **Crashed** ({@link isDatabaseCrashError}): the server ended a session with
 *   the statement possibly IN FLIGHT — 57P01/57P02, the 08000/08003/08006
 *   connection failures, a reset socket, a broken pipe, a read that timed out,
 *   and pg's bare "Connection terminated unexpectedly". A statement can crash
 *   Postgres, not just meet a crash — a TimescaleDB 2.28 segfault during a bulk
 *   upsert is the precedent — and from the client "met a crash" and "caused
 *   one" look identical. Sending it again after recovery would restart the
 *   whole appliance's database again, every time. So
 *   {@link retryOnTransientDatabaseError} never does: it raises
 *   {@link DatabaseCrashedError} on the first crash and the caller stops its
 *   unit of work (the import push fails its stage with every unsettled row
 *   still `pending`).
 *
 * Anything that cannot be told apart is a crash. Reading a crash as "not
 * ready" is the direction that loops — resend, crash, recover, resend — while
 * reading "not ready" as a crash costs one failed stage a person re-drives.
 * That is why pg's "Connection terminated unexpectedly" is a crash even though
 * pg raises the very same bare Error when a socket closes during CONNECT,
 * before any statement was sent: nothing on the error says which it was.
 * (TypeORM wraps a statement's failure in a `QueryFailedError` and a connect
 * failure not, but that only holds for as long as every service in between
 * keeps the chain intact, and one that re-throws `new Error(err.message)` would
 * turn a poison write into a resend loop.)
 *
 * Both are TRANSIENT ({@link isTransientDatabaseError}): neither says anything
 * about the row, and neither is ever a reason to quarantine one.
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
 * codes. All of those are walked, outermost first, and the first link that
 * names a known moment decides.
 *
 * The message is consulted only when NOTHING in that chain carries a code —
 * `pg`'s own "Connection terminated unexpectedly" is a bare `Error`, and a
 * failure that crossed a string boundary (GraphIngestService reports each
 * failed entity as `entity <key>: <message>`) has only its text left. A chain
 * that does carry a code, and not a transient one, is decided by that code and
 * never by wording that happens to appear in it.
 */

/** Which of the two moments above a failure was. */
export type DatabaseAbsence = 'not_ready' | 'crashed';

/**
 * SQLSTATEs that mean the server never took the statement.
 *
 * Deliberately short. Serialization failures and deadlocks (40001, 40P01) are
 * retryable too, but they are about contention between writers, not about the
 * server being away, and the callers of this module decide what to do with the
 * ROW on the strength of the answer.
 */
export const NOT_READY_SQLSTATES: ReadonlySet<string> = new Set([
  /**
   * cannot_connect_now — "the database system is in recovery mode", "…is not
   * yet accepting connections", "…is starting up", "…is shutting down". The
   * code the incident above actually produced.
   */
  '57P03',
  /** sqlclient_unable_to_establish_sqlconnection — refused while connecting. */
  '08001',
  /** sqlserver_rejected_establishment_of_sqlconnection — likewise. */
  '08004',
  /** too_many_connections — the server is up and full; a slot frees in seconds. */
  '53300',
]);

/**
 * SQLSTATEs the server sends when it ENDS a session, or that name a connection
 * lost mid-session — so a statement may have been running on it.
 *
 * 57P02 is what every OTHER backend is told when one backend crashes; the one
 * that crashed tells its client nothing, and the client sees its socket close
 * (see {@link CRASH_NETWORK_CODES} and pg's "Connection terminated
 * unexpectedly").
 */
export const CRASH_SQLSTATES: ReadonlySet<string> = new Set([
  /** admin_shutdown — "terminating connection due to administrator command". */
  '57P01',
  /** crash_shutdown — "terminating connection because of crash of another server process". */
  '57P02',
  /** connection_exception, connection_does_not_exist, connection_failure. */
  '08000',
  '08003',
  '08006',
]);

/** Every SQLSTATE that means the server was away rather than refusing. */
export const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([...NOT_READY_SQLSTATES, ...CRASH_SQLSTATES]);

/**
 * Socket codes raised while CONNECTING — before any statement could be sent.
 * `ETIMEDOUT` is here only when its `syscall` is `connect` (see
 * {@link socketAbsence}); on an open socket it is a crash.
 */
export const NOT_READY_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * Socket codes for a connection that was up and went away under a request.
 * `EPIPE` is OUR write meeting a closed socket, and is here all the same: the
 * query's messages go out in one write, so a pipe that broke may have broken
 * after the server had them, and nothing on the error says which.
 */
export const CRASH_NETWORK_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/** Every socket code a restarting server produces on the way down and back up. */
export const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  ...NOT_READY_NETWORK_CODES,
  ...CRASH_NETWORK_CODES,
]);

/**
 * The wording of "never took the statement", for an error with no code.
 * Matched as substrings, case-sensitively, exactly as the server and driver
 * spell them.
 */
const NOT_READY_MESSAGES: readonly string[] = [
  'the database system is in recovery mode',
  'the database system is not yet accepting connections',
  'the database system is starting up',
  'the database system is shutting down',
  // pg-pool, when a new client did not connect within connectionTimeoutMillis.
  // Its `cause` is pg's "Connection terminated unexpectedly" — the pool killed
  // the socket itself — which is why the outermost link decides.
  'Connection terminated due to connection timeout',
  // pg-pool, when no connection could be had within connectionTimeoutMillis.
  'timeout exceeded when trying to connect',
  // pg, refusing a query on a client whose connection already failed: the
  // statement is rejected before it is written.
  'Client has encountered a connection error and is not queryable',
  'sorry, too many clients already',
  'remaining connection slots are reserved',
];

/** The wording of "ended with a statement possibly in flight". */
const CRASH_MESSAGES: readonly string[] = [
  'terminating connection due to administrator command',
  'terminating connection because of crash of another server process',
  // pg's Client, when the socket closes under it — see the module doc.
  'Connection terminated unexpectedly',
];

/**
 * Socket codes inside a message: `connect ECONNREFUSED 172.18.0.2:5432`,
 * `read ECONNRESET`. A `connect ETIMEDOUT` is a connect that timed out; any
 * other ETIMEDOUT is an open socket that stopped answering.
 */
const NOT_READY_CODE_IN_MESSAGE = new RegExp(
  `\\b(?:${[...NOT_READY_NETWORK_CODES].join('|')})\\b|\\bconnect ETIMEDOUT\\b`,
);
const CRASH_CODE_IN_MESSAGE = /\b(?:ECONNRESET|EPIPE)\b|(?<!connect )\bETIMEDOUT\b/;

/**
 * A failure the caller KNOWS was the database being away but can no longer
 * show a code for — the base of the verdict classes below.
 *
 * Instantiated bare, it says "away" without saying which moment, and it is
 * read the safe way: as a crash, never resent. Say which with
 * {@link DatabaseNotReadyError} or {@link DatabaseCrashedError}.
 */
export class TransientDatabaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientDatabaseError';
  }
}

/**
 * The caller knows the statement never ran — the server was not taking
 * statements — and can no longer show a code for it.
 *
 * The entity lane is the case: `GraphIngestService.ingest` catches a
 * batch-level failure and reports it per entity as text, so by the time the
 * push sees it the error object is gone. Wrapping the text in this class states
 * the verdict explicitly rather than re-deriving it at every layer.
 */
export class DatabaseNotReadyError extends TransientDatabaseError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseNotReadyError';
  }
}

/**
 * The database stayed not-ready for longer than the caller was willing to
 * wait.
 *
 * Transient — nothing about the work is wrong, and a caller deciding whether to
 * quarantine a row must still answer "no". What it changes is who retries: the
 * caller gave up waiting, so this is raised out to whatever can try again later
 * (for an import stage, a person re-driving it). A nested
 * {@link retryOnTransientDatabaseError} never waits on it again.
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
        `(${attempts} attempt(s); last error: ${describeError(cause)})`,
      { cause },
    );
    this.name = 'DatabaseUnavailableError';
  }
}

/**
 * The database went down with this operation possibly in flight, so the
 * operation was NOT sent again — see the module doc.
 *
 * Transient, like the rest: the row is not known to be at fault and must not be
 * quarantined for it. What it forbids is the resend. A caller catching it
 * stops the unit of work the operation belonged to, leaving what it had not
 * settled exactly where it was, for a person to re-drive once the database is
 * healthy — and, if the same place crashes it again, to look at the data.
 * {@link retryOnTransientDatabaseError} raises it on the first crash and never
 * waits on one it is handed.
 */
export class DatabaseCrashedError extends TransientDatabaseError {
  constructor(
    readonly operation: string,
    cause: unknown,
    message = `the database went down with ${operation} possibly in flight, so it was not sent again ` +
      `(last error: ${describeError(cause)})`,
  ) {
    super(message, { cause });
    this.name = 'DatabaseCrashedError';
  }
}

/**
 * Was this failure the database being away, and which moment was it? `null`
 * when the database answered — a refusal, a constraint, anything about the
 * statement itself.
 */
export function classifyDatabaseError(err: unknown): DatabaseAbsence | null {
  const links = collect(err);

  for (const link of links) {
    if (link.verdict != null) {
      return link.verdict;
    }
  }

  const coded = links.filter((link) => link.code != null);

  if (coded.length > 0) {
    // Codes decide. The first transient one wins, outermost first; a chain
    // whose codes are all something else is a refusal, whatever its prose says.
    for (const link of coded) {
      const absence = sqlstateAbsence(link.code!) ?? socketAbsence(link.code!, link.syscall);

      if (absence != null) {
        return absence;
      }
    }

    return null;
  }

  for (const link of links) {
    const absence = classifyDatabaseMessage(link.message);

    if (absence != null) {
      return absence;
    }
  }

  return null;
}

/** Is this failure the database being away, rather than the database refusing? */
export function isTransientDatabaseError(err: unknown): boolean {
  return classifyDatabaseError(err) != null;
}

/** Did the server never take the statement — safe to wait and send it again? */
export function isDatabaseNotReadyError(err: unknown): boolean {
  return classifyDatabaseError(err) === 'not_ready';
}

/**
 * Did the database end the session with a statement possibly IN FLIGHT —
 * crash, forced shutdown, reset socket — so it must not be sent again? Includes
 * the verdict classes that say so ({@link DatabaseCrashedError}, and a bare
 * {@link TransientDatabaseError}).
 */
export function isDatabaseCrashError(err: unknown): boolean {
  return classifyDatabaseError(err) === 'crashed';
}

/**
 * The message-only half, for a failure that crossed a string boundary. Prefer
 * {@link classifyDatabaseError} whenever an error object is still in hand.
 *
 * Within one message a crash wins: text that names both moments cannot be
 * shown to be the harmless one.
 */
export function classifyDatabaseMessage(message: string | null | undefined): DatabaseAbsence | null {
  if (message == null || message.length === 0) {
    return null;
  }

  if (CRASH_MESSAGES.some((needle) => message.includes(needle)) || CRASH_CODE_IN_MESSAGE.test(message)) {
    return 'crashed';
  }

  if (
    NOT_READY_MESSAGES.some((needle) => message.includes(needle)) ||
    NOT_READY_CODE_IN_MESSAGE.test(message)
  ) {
    return 'not_ready';
  }

  return null;
}

/** {@link classifyDatabaseMessage}, as a yes/no: was the database away at all? */
export function isTransientDatabaseMessage(message: string | null | undefined): boolean {
  return classifyDatabaseMessage(message) != null;
}

function sqlstateAbsence(code: string): DatabaseAbsence | null {
  if (NOT_READY_SQLSTATES.has(code)) {
    return 'not_ready';
  }

  return CRASH_SQLSTATES.has(code) ? 'crashed' : null;
}

/**
 * A Node socket code. ETIMEDOUT is the one code that is both: Node sets
 * `syscall: 'connect'` on a connect that timed out, which never sent anything.
 */
function socketAbsence(code: string, syscall: string | null): DatabaseAbsence | null {
  if (NOT_READY_NETWORK_CODES.has(code)) {
    return 'not_ready';
  }

  if (code === 'ETIMEDOUT' && syscall === 'connect') {
    return 'not_ready';
  }

  return CRASH_NETWORK_CODES.has(code) ? 'crashed' : null;
}

/** How deep a `cause` chain is followed. Real chains are two or three long. */
const MAX_CHAIN_DEPTH = 6;

interface Link {
  code: string | null;
  syscall: string | null;
  message: string | null;
  /** What the link's CLASS already says, if it is one of the verdict classes. */
  verdict: DatabaseAbsence | null;
}

/**
 * Every link of the error — itself, its `driverError`, its `cause` chain and an
 * AggregateError's members — outermost first.
 *
 * A verdict class ends the walk at that link: {@link DatabaseCrashedError}
 * wraps a crash precisely BECAUSE it has decided the operation is not to be
 * resent, and {@link DatabaseUnavailableError} a not-ready failure because it
 * has decided to stop waiting; reading through either to its cause would undo
 * the decision.
 */
function collect(err: unknown): Link[] {
  const links: Link[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (value == null || typeof value !== 'object' || depth > MAX_CHAIN_DEPTH || seen.has(value)) {
      return;
    }

    seen.add(value);

    const verdict = verdictOf(value);

    if (verdict != null) {
      links.push({ code: null, syscall: null, message: null, verdict });

      return;
    }

    const shaped = value as {
      code?: unknown;
      syscall?: unknown;
      message?: unknown;
      driverError?: unknown;
      cause?: unknown;
      errors?: unknown;
    };

    links.push({
      code: typeof shaped.code === 'string' && shaped.code.length > 0 ? shaped.code : null,
      syscall: typeof shaped.syscall === 'string' ? shaped.syscall : null,
      message: typeof shaped.message === 'string' ? shaped.message : null,
      verdict: null,
    });

    visit(shaped.driverError, depth + 1);
    visit(shaped.cause, depth + 1);

    if (Array.isArray(shaped.errors)) {
      for (const member of shaped.errors) {
        visit(member, depth + 1);
      }
    }
  };

  visit(err, 0);

  return links;
}

/**
 * What an error's CLASS already says. A bare {@link TransientDatabaseError}
 * says "away" without saying when, and is read the safe way — see its doc.
 */
function verdictOf(value: object): DatabaseAbsence | null {
  if (value instanceof DatabaseNotReadyError || value instanceof DatabaseUnavailableError) {
    return 'not_ready';
  }

  if (value instanceof TransientDatabaseError) {
    return 'crashed';
  }

  return null;
}

function describeError(err: unknown): string {
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
   * Wait out a CRASH too, and send the operation again once the server is
   * back, exactly as for a server that was not ready.
   *
   * Only for an operation that cannot be what crashed the server and lands on
   * the same row however often it is repeated: an UPDATE by id of the caller's
   * own bookkeeping (recording that an import stage failed). Never for a write
   * of foreign data, which is exactly what can crash it. Unset, a crash is
   * raised as {@link DatabaseCrashedError} at once.
   */
  resendAfterCrash?: boolean;
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
 * Run `op`, and when it fails because the database was NOT READY to take it,
 * wait and run it again — until it succeeds, fails for any other reason, or the
 * budget is spent.
 *
 * - A failure that is not the database being away is rethrown untouched on the
 *   attempt it happened, so a caller's own handling (quarantine the row, dedup
 *   on 23505, stop on 53100) sees exactly what it always saw.
 * - A CRASH — the server ended the session with `op` possibly in flight — is
 *   raised at once as {@link DatabaseCrashedError}, `op` NOT sent again (unless
 *   the policy says `resendAfterCrash`). See the module doc for why.
 * - A not-ready failure that outlasts the budget is rethrown as
 *   {@link DatabaseUnavailableError}, with the last error as its `cause`.
 * - Either verdict coming out of `op` itself — a nested helper that already
 *   decided — goes straight up: waiting again would multiply the budget, and
 *   resending would undo the crash decision.
 *
 * `op` must be safe to repeat after a not-ready failure. That is nearly free —
 * the server did not take the statement — but it is still the caller's promise,
 * not something this can check: an `op` of several statements may have
 * committed its first before the second met a server that was going away. For
 * the import push, "safe" means "repeats land on the same rows", which each
 * destination earns its own way: most upsert on the provenance triple
 * (source_system, source_id, source_type); `position` has no triple and dedupes
 * by timestamp (`PositionService` skips a time it already holds); `receipts`
 * upserts its header on the triple and its lines on `(receipt_id, line_number)`,
 * one transaction per receipt. The ledger writes are UPDATEs by row id. A new
 * destination that has none of these is not safe to hand to this until it
 * does.
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
      if (err instanceof DatabaseUnavailableError || err instanceof DatabaseCrashedError) {
        throw err;
      }

      const absence = classifyDatabaseError(err);

      if (absence == null) {
        throw err;
      }

      if (absence === 'crashed' && policy.resendAfterCrash !== true) {
        throw new DatabaseCrashedError(operation, err);
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
