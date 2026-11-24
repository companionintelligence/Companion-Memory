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
 * `infrastructure/powersync/README.md`. It supports **notes and saved searches**:
 *
 *   - notes:      full create/update/delete via `createNote`/`updateNote`/`deleteNote`
 *                 (`NoteResolver`). Simple per-row CRUD, so it fits the replay model.
 *   - saved_searches: full create/update/delete via `createSavedSearch`/
 *                 `updateSavedSearch`/`deleteSavedSearch` (`SavedSearchResolver`), the
 *                 same shape. The device writes the definition (name, description,
 *                 query, entity_types, tags, filters); the JSON-text columns are parsed
 *                 back into the arrays and object the input types take. Sharing
 *                 (`is_public`, `share_token`) is server-managed and never written on
 *                 the device, so a PATCH never carries it; one that somehow did is
 *                 ignored here rather than mapped to `setSavedSearchSharing`.
 *   - tags:       READ-ONLY. `TagResolver` has no `createTag`/`updateTag`/`deleteTag`
 *                 mutation — only `tagEntities`/`untagEntities`, which mutate the
 *                 entity_tag join table (labels attached to OTHER entities) and only
 *                 create/touch a tag row as a side effect. There is no mutation shaped
 *                 like "create/update/delete a tag by id", which is what a `tags` CRUD
 *                 replay needs. Guessing at one would violate the "don't guess, read
 *                 the real resolvers" rule this connector was built under, so `tags`
 *                 stays read-only until a real tag-by-id mutation exists.
 *   - entity_tag: READ-ONLY. The tag-to-entity join, synced so a tag filter can
 *                 apply offline. `tagEntities`/`untagEntities` could replay it one
 *                 day; nothing on the device writes it yet.
 *
 * `mobile_search_documents` is a raw table the sync client writes directly
 * (searchIndex.ts); it never enters the CRUD queue. Until 2026-10-21 `threads`,
 * `messages`, `files`, `events` and `entities` synced too, read-only; they left the
 * sync rules and the schema together (one device record per entity — see
 * schema.ts), and a stale CRUD entry for one of them, if any, lands in the
 * "unrecognized table" branch of `replay()` and is dropped the same way.
 *
 * A local write against a read-only table would sit in the CRUD queue and get
 * dropped (logged, not retried — see `replay()`) rather than silently retried
 * forever, but the real fix is: don't build UI that writes to those tables yet.
 *
 * Note ids: `notes.id` here is the raw Postgres uuid (per sync-rules.yaml), but
 * `createNote`/`updateNote`/`deleteNote` take the base64 `"note:<uuid>"` global id
 * GraphQL uses everywhere else (`GlobalUID`, mirrored client-side in `@ci/common`
 * from the backend's `graphql/types/GlobalUID.ts`) — `GlobalUID.encode('note',
 * op.id)` below bridges that for all three. A CREATE sends the row's own id too
 * (`CreateNoteInput.id`, since 2026-10-22): the server keeps it, so the note that
 * syncs back down is this row and not a duplicate under a server-minted id.
 */
import { apiKeyHeaders, buildApiUrl, getApiBaseUrl, getApiKey, GlobalUID } from '@ci/common';
import type {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/web';
import { UpdateType } from '@powersync/web';

import { getWorkingSetCutoffIso } from './workingSet';

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

const CREATE_SAVED_SEARCH_MUTATION = `
  mutation PowerSyncCreateSavedSearch($input: CreateSavedSearchInput!) {
    createSavedSearch(input: $input) {
      success
      savedSearch {
        id
      }
    }
  }
`;

const UPDATE_SAVED_SEARCH_MUTATION = `
  mutation PowerSyncUpdateSavedSearch($input: UpdateSavedSearchInput!) {
    updateSavedSearch(input: $input) {
      success
    }
  }
`;

const DELETE_SAVED_SEARCH_MUTATION = `
  mutation PowerSyncDeleteSavedSearch($input: DeleteByIdInput!) {
    deleteSavedSearch(input: $input) {
      success
    }
  }
`;

/**
 * A `text[]` or jsonb column as the device stores it (JSON text) back to the value the
 * GraphQL input takes. `undefined` for an absent key (a PATCH that did not touch it, which
 * JSON.stringify then drops so the server leaves the column alone); `null` for an explicit
 * NULL; the parsed value otherwise. Text that is not JSON is passed through as-is, so a
 * bad row fails loudly at the resolver (a PermanentMutationError) instead of being guessed at.
 */
function jsonColumn(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Tables whose local writes are intentionally not replayed — see the module comment. */
const READ_ONLY_TABLES = new Set(['tags', 'entity_tag']);

/**
 * The 503 a Memory server sends when it runs no PowerSync service (every
 * Marketplace install today). `code` is what current servers send; servers
 * released before it only send the exception's `message`.
 */
const POWERSYNC_NOT_CONFIGURED_CODE = 'POWERSYNC_NOT_CONFIGURED';
const POWERSYNC_NOT_CONFIGURED_MESSAGE = 'PowerSync is not configured';

/**
 * Upper bound on the whole token request, body included. The SDK awaits
 * `fetchCredentials()` without a signal of its own, so a request that never
 * finishes holds the sync loop, and any `disconnect()` waiting on it, until the
 * page closes.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Whether a 503 from the token endpoint means "this server has no PowerSync",
 * as opposed to a gateway or proxy 503 while the server restarts, which is
 * worth retrying. Only the API's own JSON body counts.
 */
async function isNotConfiguredResponse(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown } | null;

    return body?.code === POWERSYNC_NOT_CONFIGURED_CODE || body?.message === POWERSYNC_NOT_CONFIGURED_MESSAGE;
  } catch {
    return false;
  }
}

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
   * @param onSyncUnavailable Called with the API origin that answered when that
   *   server says it runs no PowerSync service. Returning null alone does not
   *   stop the SDK: it treats missing credentials as "not signed in yet" and asks
   *   again after `retryDelayMs` (5 s), for as long as the database stays
   *   connected. The caller has to disconnect.
   */
  constructor(
    private readonly getAuthToken: () => string | null,
    private readonly onSyncUnavailable?: (origin: string) => void,
  ) {}

  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const token = this.getAuthToken();
    const apiKey = getApiKey();

    if (!token && !apiKey) {
      // Not signed in (web: no JWT yet; native: no keystore API key yet). PowerSync
      // calls this again before its next connection attempt.
      return null;
    }

    const cutoff = encodeURIComponent(getWorkingSetCutoffIso());
    // The server this request goes to. The app can point at another one while the
    // request is in flight, so the answer is reported against this origin.
    const origin = getApiBaseUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(buildApiUrl(`/api/powersync/token?cutoff=${cutoff}`), {
        headers: {
          ...apiKeyHeaders(),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      });

      if (response.status === 503 && (await isNotConfiguredResponse(response))) {
        // This server runs no PowerSync service. Stay GraphQL-only and tell the
        // provider, which disconnects so nothing asks this server again.
        console.info('[PowerSync] Not configured on this Memory server; staying GraphQL-only');
        this.onSyncUnavailable?.(origin);

        return null;
      }

      if (!response.ok) {
        // Network or server error reaching our own API, including a proxy's 503
        // while it restarts. Transient, so let PowerSync retry.
        throw new Error(`Failed to fetch PowerSync credentials (${response.status})`);
      }

      const body = (await response.json()) as { token: string; powersync_url: string };

      return {
        endpoint: body.powersync_url,
        token: body.token,
      };
    } finally {
      clearTimeout(timer);
    }
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
          console.error(
            `[PowerSync] Dropping unreplayable ${op.op} on ${op.table}#${op.id}: ${error.message}`,
          );
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

    if (op.table === 'saved_searches') {
      return this.replaySavedSearch(op);
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
        // The row's own id goes with the create, so the server keeps it and the
        // note that syncs back down is this row, not a duplicate under a new id.
        const result = await this.request(CREATE_NOTE_MUTATION, {
          input: {
            id: GlobalUID.encode('note', op.id),
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

  private async replaySavedSearch(op: CrudEntry): Promise<void> {
    const id = GlobalUID.encode('saved-search', op.id);

    switch (op.op) {
      case UpdateType.PUT: {
        // The row's own id goes with the create, so the server keeps it and the
        // search that syncs back down is this row, not a duplicate under a new id.
        const result = await this.request(CREATE_SAVED_SEARCH_MUTATION, {
          input: {
            id,
            name: op.opData?.name ?? null,
            description: op.opData?.description ?? null,
            query: op.opData?.query ?? null,
            entityTypes: jsonColumn(op.opData?.entity_types) ?? [],
            tags: jsonColumn(op.opData?.tags) ?? [],
            filters: jsonColumn(op.opData?.filters) ?? null,
          },
        });

        assertMutationSucceeded(result, 'createSavedSearch');

        return;
      }

      case UpdateType.PATCH: {
        // Only columns that actually changed are present on a PATCH; `undefined` keys
        // are dropped by JSON.stringify, so the mutation leaves those columns alone.
        // `updated_at` is the server's to stamp, and the sharing columns are not the
        // device's to write (see the module comment), so none of those are forwarded.
        const result = await this.request(UPDATE_SAVED_SEARCH_MUTATION, {
          input: {
            id,
            name: op.opData?.name,
            description: op.opData?.description,
            query: op.opData?.query,
            entityTypes: jsonColumn(op.opData?.entity_types),
            tags: jsonColumn(op.opData?.tags),
            filters: jsonColumn(op.opData?.filters),
          },
        });

        assertMutationSucceeded(result, 'updateSavedSearch');

        return;
      }

      case UpdateType.DELETE: {
        const result = await this.request(DELETE_SAVED_SEARCH_MUTATION, { input: { id } });

        assertMutationSucceeded(result, 'deleteSavedSearch');

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
