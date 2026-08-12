/**
 * PowerSync backend connector: bridges the on-device SQLite CRUD queue and
 * CI-Server's real API.
 *
 * `fetchCredentials()` mints a sync token via `GET /api/powersync/token`, using the
 * same dual x-api-key/JWT auth headers `ApolloProvider` attaches to every GraphQL
 * request (`PowerSyncController` accepts either, via `JwtOrApiKeyAuthGuard`).
 *
 * `uploadData()` replays the local CRUD queue through CI-Server's EXISTING GraphQL
 * mutations rather than writing Postgres directly — this is a hard requirement, see
 * `infrastructure/powersync/README.md`. It supports **notes only**:
 *
 *   - notes:    full create/update/delete via `createNote`/`updateNote`/`deleteNote`
 *               (`NoteResolver`). Simple per-row CRUD, so it fits the replay model.
 *   - tags:     READ-ONLY. `TagResolver` has no `createTag`/`updateTag`/`deleteTag`
 *               mutation — only `tagEntities`/`untagEntities`, which mutate the
 *               entity_tag join table (labels attached to OTHER entities) and only
 *               create/touch a tag row as a side effect. There is no mutation shaped
 *               like "create/update/delete a tag by id", which is what a `tags` CRUD
 *               replay needs. Guessing at one would violate the "don't guess, read
 *               the real resolvers" rule this connector was built under, so `tags`
 *               stays read-only alongside threads/messages below until a real
 *               tag-by-id mutation exists.
 *   - threads:  READ-ONLY. REST-only CRUD server-side; no GraphQL mutation exists.
 *   - messages: READ-ONLY. A message is only ever created as a side effect of
 *               `POST /llm/generate`, which also triggers live LLM inference — there
 *               is no standalone "create message" mutation to replay a local insert
 *               through.
 *   - files:    READ-ONLY. Metadata mirror only; the binary lives in Minio.
 *
 * A local write against a read-only table would sit in the CRUD queue and get
 * dropped (logged, not retried — see `replay()`) rather than silently retried
 * forever, but the real fix is: don't build UI that writes to those tables yet.
 *
 * KNOWN LIMITATION — note id reconciliation: `notes.id` here is the raw Postgres
 * uuid (per sync-rules.yaml), but `createNote`/`updateNote`/`deleteNote` take the
 * base64 `"note:<uuid>"` global id GraphQL uses everywhere else (`GlobalUID`, mirrored
 * client-side in `@ci/common`'s `GlobalUID` from the backend's
 * `graphql/types/GlobalUID.ts`) — `GlobalUID.encode('note', op.id)` below bridges
 * that. For UPDATE/DELETE this is exact: the row's id has already round-tripped
 * through a prior create. For CREATE it is NOT: `CreateNoteInput` has no `id` field
 * (even though `NoteService.create`/`CreateNoteDto` already accept one — the GraphQL
 * input just doesn't expose it), so the server always mints its own id, different
 * from the id this device generated locally for the new row. This pass does not
 * reconcile the two: the locally-created row keeps its client-generated id until the
 * server's row syncs back down under its real id, which will appear as a short-lived
 * duplicate, and any local edit to the not-yet-reconciled row made in that window
 * will fail closed (see `assertMutationSucceeded`) rather than corrupt another row.
 * The clean fix is additive and small — add an optional `id` to `CreateNoteInput`
 * and thread it into `NoteResolver.createNote` — but it's a backend schema change
 * outside this client-integration pass's scope, so it's called out here instead of
 * silently patched in.
 */
import { apiKeyHeaders, buildApiUrl, getApiKey, GlobalUID } from '@ci/common';
import type {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/web';
import { UpdateType } from '@powersync/web';

const CREATE_NOTE_MUTATION = `
  mutation PowerSyncCreateNote($input: CreateNoteInput!) {
    createNote(input: $input) {
      success
      note {
        id
      }
    }
  }
`;

const UPDATE_NOTE_MUTATION = `
  mutation PowerSyncUpdateNote($input: UpdateNoteInput!) {
    updateNote(input: $input) {
      success
    }
  }
`;

const DELETE_NOTE_MUTATION = `
  mutation PowerSyncDeleteNote($input: DeleteByIdInput!) {
    deleteNote(input: $input) {
      success
    }
  }
`;

/** Tables whose local writes are intentionally not replayed — see the module comment. */
const READ_ONLY_TABLES = new Set(['tags', 'threads', 'messages', 'files']);

type GraphQLResponse = {
  data?: Record<string, { success?: boolean } | null> | null;
  errors?: Array<{ message: string }>;
};

/**
 * Thrown for a permanent, per-record failure (a GraphQL error, or a
 * `{ success: false }` payload — this codebase's convention for "not found for this
 * user" / validation failures). The uploadData loop swallows this so the CRUD queue
 * doesn't retry a record that will never succeed; anything else (network failure,
 * non-2xx transport error) propagates so PowerSync retries the whole transaction.
 */
class PermanentMutationError extends Error {}

export class GraphQLBackendConnector implements PowerSyncBackendConnector {
  /**
   * @param getAuthToken Reads the current web JWT (or null). Read on every call —
   *   never cached — so a refreshed token is picked up without reconnecting.
   */
  constructor(private readonly getAuthToken: () => string | null) {}

  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const token = this.getAuthToken();
    const apiKey = getApiKey();

    if (!token && !apiKey) {
      // Not signed in (web: no JWT yet; native: no keystore API key yet). PowerSync
      // calls this again before its next connection attempt.
      return null;
    }

    const response = await fetch(buildApiUrl('/api/powersync/token'), {
      headers: {
        ...apiKeyHeaders(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      // Network/server error reaching our own API — transient, let PowerSync retry.
      throw new Error(`Failed to fetch PowerSync credentials (${response.status})`);
    }

    const body = (await response.json()) as { token: string; powersync_url: string };

    return {
      endpoint: body.powersync_url,
      token: body.token,
    };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();

    if (!transaction) {
      return;
    }

    for (const op of transaction.crud) {
      try {
        await this.replay(op);
      } catch (error) {
        if (error instanceof PermanentMutationError) {
          // This specific record will never succeed (bad input, or it belongs to a
          // note the server doesn't recognize for this user) — drop it and move on
          // rather than retrying it forever.
          console.error(`[PowerSync] Dropping unreplayable ${op.op} on notes#${op.id}: ${error.message}`);
          continue;
        }

        // Network error or unexpected transport failure — let PowerSync retry the
        // whole transaction after its configured backoff.
        throw error;
      }
    }

    await transaction.complete();
  }

  private async replay(op: CrudEntry): Promise<void> {
    if (op.table === 'notes') {
      return this.replayNote(op);
    }

    if (READ_ONLY_TABLES.has(op.table)) {
      // See the module comment: these tables have no write path yet. Log and drop
      // rather than retrying forever — the fix is in the UI that produced this
      // write, not in this connector.
      console.warn(`[PowerSync] Ignoring ${op.op} on read-only table "${op.table}" (id ${op.id})`);

      return;
    }

    console.warn(`[PowerSync] Ignoring ${op.op} on unrecognized table "${op.table}" (id ${op.id})`);
  }

  private async replayNote(op: CrudEntry): Promise<void> {
    switch (op.op) {
      case UpdateType.PUT: {
        const result = await this.request(CREATE_NOTE_MUTATION, {
          input: {
            title: op.opData?.title ?? null,
            content: op.opData?.content ?? null,
          },
        });

        assertMutationSucceeded(result, 'createNote');

        return;
      }

      case UpdateType.PATCH: {
        const result = await this.request(UPDATE_NOTE_MUTATION, {
          input: {
            id: GlobalUID.encode('note', op.id),
            // Only columns that actually changed are present on a PATCH; omitted
            // keys serialize to `undefined` and are dropped by JSON.stringify, so
            // the mutation leaves those columns untouched server-side.
            title: op.opData?.title,
            content: op.opData?.content,
          },
        });

        assertMutationSucceeded(result, 'updateNote');

        return;
      }

      case UpdateType.DELETE: {
        const result = await this.request(DELETE_NOTE_MUTATION, {
          input: { id: GlobalUID.encode('note', op.id) },
        });

        assertMutationSucceeded(result, 'deleteNote');

        return;
      }
    }
  }

  private async request(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse> {
    const token = this.getAuthToken();

    const response = await fetch(buildApiUrl('/api/graphql'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...apiKeyHeaders(),
        authorization: token ? `Bearer ${token}` : '',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      // Non-2xx transport failure (5xx, proxy/network issue) — transient.
      throw new Error(`GraphQL request failed (${response.status})`);
    }

    const body = (await response.json()) as GraphQLResponse;

    if (body.errors?.length) {
      // The resolver rejected this specific record (bad input, thrown validation
      // error) — permanent, not transient.
      throw new PermanentMutationError(body.errors.map((e) => e.message).join('; '));
    }

    return body;
  }
}

/**
 * `createNote`/`updateNote`/`deleteNote` all return `{ success: boolean, ... }`
 * rather than throwing when the target row isn't found for this user (see
 * `NoteResolver`) — that's this codebase's convention for a permanent, per-record
 * failure, so treat it the same as a thrown GraphQL error.
 */
function assertMutationSucceeded(result: GraphQLResponse, field: string): void {
  const payload = result.data?.[field];

  if (payload && payload.success === false) {
    throw new PermanentMutationError(`${field} reported success: false`);
  }
}
