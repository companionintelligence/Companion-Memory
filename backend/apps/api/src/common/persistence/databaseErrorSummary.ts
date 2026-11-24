import { classifyDatabaseError } from './transientDatabaseError';

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** What kind of database failure an error was, without the driver's text. */
export interface DatabaseErrorSummary {
  /** `unavailable`: the server was away. `refused`: it took the statement and said no. */
  readonly kind: 'unavailable' | 'refused';
  /** The SQLSTATE, or the socket code for a connection that never reached the server. */
  readonly code: string;
  /** The constraint a refusal names, when it names one. */
  readonly constraint: string | null;
}

/**
 * Sum up a database error so a response can say what happened without copying
 * the driver's message, or return null when `err` is not one.
 *
 * The message is what leaks. A refusal names internal relations (a position
 * with no location came back as `new row for relation "_hyper_13_2_chunk"
 * violates check constraint "valid_positioning"`), columns and constraint
 * names, and a connection failure names the server's address (`connect
 * ECONNREFUSED 172.18.0.2:5432`). A caller words its own sentence from this and
 * logs the original.
 *
 * Null for an error with no code, so an application's own message (a
 * validation error a service raised) can still be passed on as it always was.
 * {@link classifyDatabaseError} decides "away" first, on codes, so a socket
 * code that looks like a SQLSTATE (EPIPE) reads as an outage and not a
 * refusal.
 */
export function summarizeDatabaseError(err: unknown): DatabaseErrorSummary | null {
  const { code, constraint, driverError } = (err ?? {}) as {
    code?: unknown;
    constraint?: unknown;
    driverError?: { code?: unknown; constraint?: unknown };
  };
  const codes = [code, driverError?.code].filter(
    (candidate): candidate is string => typeof candidate === 'string',
  );

  if (codes.length === 0) {
    return null;
  }

  if (classifyDatabaseError(err) != null) {
    return { kind: 'unavailable', code: codes[0], constraint: null };
  }

  const sqlState = codes.find((candidate) => SQLSTATE.test(candidate));

  if (sqlState == null) {
    return null;
  }

  const name = [constraint, driverError?.constraint].find(
    (candidate): candidate is string => typeof candidate === 'string',
  );

  return { kind: 'refused', code: sqlState, constraint: name ?? null };
}
