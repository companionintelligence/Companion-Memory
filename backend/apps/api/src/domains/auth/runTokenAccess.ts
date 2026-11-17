import type { Request } from 'express';
import { type DocumentNode, Kind, parse } from 'graphql';

/**
 * What a Python function run token may do as a bearer.
 *
 * `PythonFunctionTokenService` mints one per dispatched job, signed with the session secret and with
 * the job's user as `sub`, so HBPE can read that user's data over GraphQL while the run lasts (about
 * 8 hours on its queue). `JwtStrategy` checked only `sub`, so the same token was a full session for
 * every JWT-guarded route: `POST /keys` minted a permanent full-capability key from it, and the
 * owner's token reached the admin-only MCP `test-connection`, which spawns a command. Code running
 * in a sidecar — a parser bug in an imported file is enough — got the owner's account.
 *
 * Now a token carrying a `purpose` is refused unless it is a run token on a GraphQL request whose
 * every operation is a query and whose every root field is one the sidecars read
 * ({@link RUN_TOKEN_ROOT_FIELDS}). The callback and heartbeat routes do not come through here: they
 * verify the token themselves (`PythonRunCallbackGuard`).
 */

/** `PYTHON_RUN_TOKEN_PURPOSE`, restated so auth does not import the python-functions domain (checked by a test). */
export const RUN_TOKEN_PURPOSE = 'python_run';

/**
 * Root query fields the sidecars send with a run token: HBPE's `data_client.py` (`me`, `summaries`,
 * `contents`). A new sidecar query that needs another root field must be added here.
 */
export const RUN_TOKEN_ROOT_FIELDS: ReadonlySet<string> = new Set(['me', 'summaries', 'contents', '__typename']);

/** The GraphQL endpoint itself (no global prefix; the gateway strips `/api`), never a REST route ending in it. */
const GRAPHQL_PATH = /^\/graphql\/?$/;

/** Parsed once per request: a GraphQL request runs every field's guard, and each one asks. */
const verdicts = new WeakMap<object, boolean>();

function graphqlDocumentOf(req: Request): string | undefined {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
  if (!GRAPHQL_PATH.test(path)) {return undefined;}

  const body = req.body as { query?: unknown } | undefined;
  if (req.method === 'POST' && typeof body?.query === 'string') {return body.query;}

  if (req.method === 'GET' && typeof req.query?.query === 'string') {return req.query.query;}

  return undefined;
}

/** Every definition a query, every root selection a plain field on the allowlist. Fragments refused. */
export function isRunTokenReadDocument(document: DocumentNode): boolean {
  return document.definitions.every(
    (definition) =>
      definition.kind === Kind.OPERATION_DEFINITION &&
      definition.operation === 'query' &&
      definition.selectionSet.selections.every((selection) => selection.kind === Kind.FIELD && RUN_TOKEN_ROOT_FIELDS.has(selection.name.value)),
  );
}

/** Whether `req` is a request a run token may authenticate. */
export function runTokenMayAuthenticate(req: Request): boolean {
  const cached = verdicts.get(req);
  if (cached !== undefined) {return cached;}

  let verdict = false;
  const source = graphqlDocumentOf(req);
  if (source !== undefined) {
    try {
      verdict = isRunTokenReadDocument(parse(source));
    } catch {
      verdict = false;
    }
  }

  verdicts.set(req, verdict);

  return verdict;
}
