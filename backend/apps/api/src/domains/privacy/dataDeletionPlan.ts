/**
 * Authoritative, FK-safe deletion plan for user-owned data in ci-memory.
 *
 * Every table below holds data that belongs to, or is DERIVED from, a single
 * user (their Google/OAuth-imported communications, events, files, the graph of
 * people/places/concepts extracted from them, embeddings, summaries, notes,
 * agent memory, sessions, api keys, provider credentials, …). The order matters:
 * a child table (one that FK-references another user table) MUST be listed
 * BEFORE its parent so the DELETE does not trip a RESTRICT foreign key.
 *
 * This map was built by reading `db/postgres/migrations` (the FK definitions)
 * and the domain `@Entity` decorators — NOT guessed. Notable FK facts that drive
 * the order:
 *   - `hbpe.l1_event_cluster.event_id  -> ci.events(event_id)` (no cascade)
 *   - `hbpe.l2_content_cluster.content_id -> ci.content(id)`   (no cascade)
 *     => the hbpe cluster-link tables must be purged before ci.events / ci.content.
 *   - `ci.content.event_id -> ci.events(event_id)` => content before events.
 *   - `ci.entities` / `ci.relationships` / `ci.graph_deltas` reference
 *     users with ON DELETE SET NULL, so a plain user delete would ORPHAN them
 *     (owner_user_id NULLed, row retained). We delete them explicitly so the
 *     user's derived graph is actually removed, not just detached.
 *   - api_keys / communications / events / objects / answers / files /
 *     activities / position / agent_memories / feed_queue / voice_recordings
 *     are ON DELETE CASCADE, but we still delete
 *     them explicitly (and first) so we get an accurate per-table count and do
 *     not depend on cascade for the audit tally.
 *
 * The trailing `ci.users` row itself is deleted separately by the service (it is
 * the final step of an account deletion, not a "data" table). That row points at
 * the user's own "You" person (`ci.users.entity_id -> ci.entities`, no cascade),
 * so the service clears that pointer in the same transaction as the
 * `ci.entities` delete.
 *
 * The 30-day purge (`domains/user/purge`) finds the same tables by reading the
 * catalog. `__tests__/dataDeletionPlan.integration.spec.ts` checks this list
 * against that discovery, so a new user-scoped table that is missing here fails
 * a test instead of being left behind by an immediate delete.
 */

/** A user-owned table and the column that carries the owning user's id. */
export interface UserOwnedTable {
  schema: string;
  table: string;
  /** Column holding the owning user's id (uuid). With `through`, the parent's column. */
  userColumn: string;
  /**
   * For a table with no user column of its own: its rows belong to whoever owns
   * the parent row that `column` points at, so the delete joins the parent on
   * `parentKey` and matches the parent's `userColumn`. The parent must come
   * LATER in the plan, so it is still there when this table is purged.
   */
  through?: { column: string; parentSchema: string; parentTable: string; parentKey: string };
}

/**
 * Ordered children-before-parents. Grouped by concern for readability; the array
 * order is the delete order.
 */
export const USER_OWNED_TABLES: readonly UserOwnedTable[] = [
  // --- HBPE (behavioral prediction engine) derived data. These reference
  // ci.events / ci.content / ci.users with no cascade, so they go first.
  // summary_l1_label, l1_event_cluster and l2_content_cluster have no user
  // column: each row goes with the summary, event or content it labels. ---
  {
    schema: 'hbpe',
    table: 'summary_l1_label',
    userColumn: 'user_id',
    through: { column: 'summary_id', parentSchema: 'ci', parentTable: 'summaries', parentKey: 'summary_id' },
  },
  {
    schema: 'hbpe',
    table: 'l1_event_cluster',
    userColumn: 'user_id',
    through: { column: 'event_id', parentSchema: 'ci', parentTable: 'events', parentKey: 'event_id' },
  },
  {
    schema: 'hbpe',
    table: 'l2_content_cluster',
    userColumn: 'user_id',
    through: { column: 'content_id', parentSchema: 'ci', parentTable: 'content', parentKey: 'id' },
  },
  { schema: 'hbpe', table: 'content_context', userColumn: 'user_id' },
  { schema: 'hbpe', table: 'token_stream', userColumn: 'user_id' },
  { schema: 'hbpe', table: 'prediction_log', userColumn: 'user_id' },
  // These two reference ci.users with no cascade, so leaving them blocks the
  // user row's delete. prediction_score has no foreign key and would be orphaned.
  { schema: 'hbpe', table: 'occurrence_log', userColumn: 'user_id' },
  { schema: 'hbpe', table: 'recurrence_profiles', userColumn: 'user_id' },
  { schema: 'hbpe', table: 'prediction_score', userColumn: 'user_id' },
  // l2_clusters references l1_clusters (no cascade), so it goes first.
  { schema: 'hbpe', table: 'l2_clusters', userColumn: 'user_id' },
  { schema: 'hbpe', table: 'l1_clusters', userColumn: 'user_id' },

  // --- Search index (ci_search). Keyed by (entity_type, entity_id) but also
  // carries user_id, so we can purge a user's rows directly here; the
  // OrphanCleanupService then reaps anything keyed only by a now-deleted source
  // row. Deleting these first is harmless (no inbound FKs). ---
  { schema: 'ci_search', table: 'embeddings', userColumn: 'user_id' },
  { schema: 'ci_search', table: 'vectors', userColumn: 'user_id' },
  // NOTE: ci_search.entity_tag has NO user_id (it's a join table keyed by tag_id
  // -> ci_search.tags(id), no cascade). It is purged separately in the service
  // via a subquery on the user's tags, BEFORE ci_search.tags below.
  { schema: 'ci_search', table: 'tags', userColumn: 'user_id' },

  // --- ETL / sync bookkeeping. ---
  { schema: 'ci_etl', table: 'connection_sync_jobs', userColumn: 'user_id' },
  { schema: 'ci_etl', table: 'cloud_file_ingests', userColumn: 'user_id' },
  { schema: 'ci_etl', table: 'cloud_folder_exports', userColumn: 'user_id' },

  // --- Archive imports. None of these has a foreign key to ci.users, so the user
  // row's delete would leave them all. Deleting a run takes its stages, staged
  // items (with their places and metadata), staged people and relationships by
  // cascade; staged_sources only has its run_id nulled, so it goes first. ---
  { schema: 'ci_import', table: 'staged_sources', userColumn: 'user_id' },
  { schema: 'ci_import', table: 'import_runs', userColumn: 'user_id' },

  // --- Enrichment pipeline bookkeeping, also without a foreign key. Dead letters
  // and rejected records keep the payload that failed, which is the user's data.
  // Deleting a run takes its shards by cascade. ---
  { schema: 'ci', table: 'pipeline_dead_letters', userColumn: 'user_id' },
  { schema: 'ci', table: 'record_rejections', userColumn: 'user_id' },
  { schema: 'ci', table: 'pipeline_state', userColumn: 'user_id' },
  { schema: 'ci', table: 'pipeline_schedule', userColumn: 'user_id' },
  { schema: 'ci', table: 'pipeline_turns', userColumn: 'user_id' },
  { schema: 'ci', table: 'pipeline_runs', userColumn: 'user_id' },

  // --- Multi-provenance ledger (docs/design/cross-pipeline-identity.md §5).
  // References records only logically (no FK), so position is flexible; it
  // goes before the record tables so their deletes never race its reads. ---
  { schema: 'ci', table: 'record_sources', userColumn: 'user_id' },

  // --- Graph audit + derived graph. graph_deltas references entities/
  // relationships, so delete it before them. entities/relationships use
  // owner_user_id and would otherwise be SET NULL (orphaned). ---
  { schema: 'ci', table: 'graph_deltas', userColumn: 'owner_user_id' },
  { schema: 'ci', table: 'relationships', userColumn: 'owner_user_id' },
  { schema: 'ci', table: 'entity_identifiers', userColumn: 'owner_user_id' },
  // Digests of the identifiers of people memory.forget erased: derived from a user's data, so it goes
  // with it, and counted rather than left to the cascade.
  { schema: 'ci', table: 'forgotten_identifiers', userColumn: 'owner_user_id' },
  // product_models.product_entity_id references entities with no cascade.
  { schema: 'ci', table: 'product_models', userColumn: 'user_id' },
  { schema: 'ci', table: 'entities', userColumn: 'owner_user_id' },

  // --- Core memory: content references events, so content before events. ---
  { schema: 'ci', table: 'content', userColumn: 'user_id' },
  { schema: 'ci', table: 'events', userColumn: 'user_id' },
  { schema: 'ci', table: 'communications', userColumn: 'user_id' },
  { schema: 'ci', table: 'browser_activity', userColumn: 'user_id' },
  { schema: 'ci', table: 'position', userColumn: 'user_id' },
  { schema: 'ci', table: 'objects', userColumn: 'user_id' },
  { schema: 'ci', table: 'files', userColumn: 'user_id' },

  // --- Intelligence / conversations / summaries / notes / agent memory. ---
  { schema: 'ci', table: 'actions', userColumn: 'user_id' },
  { schema: 'ci', table: 'answers', userColumn: 'user_id' },
  { schema: 'ci', table: 'summaries', userColumn: 'user_id' },
  { schema: 'ci', table: 'notes', userColumn: 'user_id' },
  { schema: 'ci', table: 'agent_memories', userColumn: 'user_id' },
  { schema: 'ci', table: 'messages', userColumn: 'user_id' },
  { schema: 'ci', table: 'threads', userColumn: 'user_id' },
  { schema: 'ci', table: 'saved_searches', userColumn: 'user_id' },
  { schema: 'ci', table: 'devices', userColumn: 'user_id' },
  // Both reference ci.users with no cascade. A private question is the user's own.
  { schema: 'ci', table: 'capture_events', userColumn: 'user_id' },
  { schema: 'ci', table: 'questions', userColumn: 'is_private_to' },
  // The appliance's one BlueBubbles connector, when this user owns it: it holds
  // the password to their Mac. The user row's delete would only null the owner
  // and keep the password; the 30-day purge deletes the row, and so does this.
  { schema: 'ci', table: 'bluebubbles_config', userColumn: 'owner_user_id' },

  // --- Identity / auth / connection credentials. Connections carry the OAuth
  // tokens; provider_keys the per-user client credentials; sessions + api_keys
  // the login/programmatic access. ---
  { schema: 'ci', table: 'provider_keys', userColumn: 'user_id' },
  { schema: 'ci', table: 'connections', userColumn: 'user_id' },
  { schema: 'ci', table: 'api_keys', userColumn: 'user_id' },
  { schema: 'ci', table: 'sessions', userColumn: 'user_id' },
];

/**
 * Per-connection derived-data tables that carry a direct `connection_id`, so a
 * single connection's derived data can be purged without touching the user's
 * other connections. Ordered children-before-parents (connections last is
 * handled by the service, not here).
 */
export interface ConnectionScopedTable {
  schema: string;
  table: string;
  /** Column holding the connection id (uuid or text). */
  connectionColumn: string;
  /**
   * Set for tables whose rows carry the cross-pipeline identity and are
   * ledgered in ci.record_sources (docs/design/cross-pipeline-identity.md §5).
   * A disconnect then deletes ONLY rows with no remaining ledger evidence
   * from another arrival — a row the Takeout import also delivered survives
   * the disconnect (with its connection_id unlinked) instead of vanishing.
   * `recordTable` is the ledger's record_table value; `pkColumn` the row's
   * primary-key column the ledger's record_id points at.
   */
  recordTable?: string;
  pkColumn?: string;
  /** The table's user-scope column, needed to join the ledger. */
  userColumn?: string;
}

export const CONNECTION_SCOPED_TABLES: readonly ConnectionScopedTable[] = [
  { schema: 'ci_etl', table: 'connection_sync_jobs', connectionColumn: 'connection_id' },
  // The cloud-drive download ledgers. Left behind, they would make a
  // reconnected drive look half-synced to anyone reading them.
  { schema: 'ci_etl', table: 'cloud_file_ingests', connectionColumn: 'connection_id' },
  { schema: 'ci_etl', table: 'cloud_folder_exports', connectionColumn: 'connection_id' },
  // Pointer rows a cloud-drive sync wrote (name, size, link — no bytes here).
  // Only those carry a connection_id; files imported or uploaded do not.
  { schema: 'ci', table: 'files', connectionColumn: 'connection_id' },
  {
    schema: 'ci',
    table: 'communications',
    connectionColumn: 'connection_id',
    recordTable: 'communications',
    pkColumn: 'id',
    userColumn: 'user_id',
  },
  {
    schema: 'ci',
    table: 'content',
    connectionColumn: 'connection_id',
    recordTable: 'content',
    pkColumn: 'id',
    userColumn: 'user_id',
  },
  {
    schema: 'ci',
    table: 'events',
    connectionColumn: 'connection_id',
    recordTable: 'events',
    pkColumn: 'event_id',
    userColumn: 'user_id',
  },
];
