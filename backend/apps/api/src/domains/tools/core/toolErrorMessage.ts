import { QueryFailedError } from 'typeorm';

import { classifyDatabaseError } from '@ci/common/persistence';

/** What a tool caller is told in place of a refused query's own text. */
export const DATABASE_ERROR_MESSAGE = 'The database refused this call. Its error is in the server log.';

/** What a tool caller is told in place of a connection failure's own text. */
export const UNAVAILABLE_ERROR_MESSAGE =
  'A service this call needs was unavailable. Its error is in the server log.';

/**
 * The message a tool caller (an MCP client, the REST intents route, the
 * agent's own prompt) may see for `error`.
 *
 * Two kinds of message describe the server rather than the call. A refused
 * query's is the driver's: it names relations, columns and constraints (`new
 * row for relation "events" violates check constraint "valid_time_range"`). A
 * connection failure's names the internal address of the database, the object
 * store or the model server (`connect ECONNREFUSED 172.18.0.2:5432`).
 * `/graphql` masks both in `formatError`; a tool handed them on, so this
 * replaces them. A connection failure is recognised by its code only: a
 * service's own sentence that happens to mention one (a files purge that says
 * what it did and did not delete) is the tool's message and passes through.
 * Every other message passes through too, because tools raise their refusals
 * as plain errors and an agent reads them to correct its call. The caller logs
 * the original.
 */
export function toolErrorMessage(error: unknown): string {
  if (error instanceof QueryFailedError) {
    return DATABASE_ERROR_MESSAGE;
  }

  const code = (error as { code?: unknown } | null)?.code;

  if (typeof code === 'string' && classifyDatabaseError(error) != null) {
    return UNAVAILABLE_ERROR_MESSAGE;
  }

  return error instanceof Error ? error.message : String(error);
}
