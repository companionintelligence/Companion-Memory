/**
 * The response bodies this CLI reads, restated.
 *
 * ## Why restated rather than imported
 *
 * This is an HTTP client, and an HTTP client is entitled to the response body —
 * not to the server's internal types. That position was already written down in
 * `client.ts` (for {@link IngestStatus}, which has since moved here) and in
 * `graphqlClient.ts`, and honoured for exactly those two surfaces — the
 * maintenance domain publishes no `IngestStatus` and the GraphQL resolver types
 * are another domain's internals. Everything else reached back into
 * `@ci/domains/maintenance` and into `domains/import/{controllers,services,doctor}`
 * for the same shapes. Those reaches are what tied a 7,900-line command-line tool
 * to a NestJS application: `backfill.test.ts` imported `ORCHESTRATE_STAGES` from
 * the maintenance barrel, and so booted fifteen Nest modules — TypeORM entities,
 * a Postgres pool, the config loader's all-zero-key warning — to learn the names
 * of seventeen strings.
 *
 * ## What that costs, honestly
 *
 * A copied type does not follow the server when it changes. That is the trade
 * this file makes, and it is the right one at this boundary: the server's types
 * are not a published contract, the wire is. A field the server adds arrives
 * anyway (`--json` prints whatever it was handed); a field the server *renames*
 * is a breaking API change that would have to be handled here regardless,
 * because a released `ci` binary is older than the appliance it is pointed at
 * more often than not.
 *
 * Every block below names the route it describes and the server type it mirrors,
 * so `grep` answers "what else moves if I change this?" in one hop. The
 * follow-up that removes the copy altogether is a shared `@ci/api-client`
 * package generated from the OpenAPI/GraphQL schema — see the package README.
 *
 * ## Dates are strings here
 *
 * The server's own interfaces type these fields as `Date`, which is true of the
 * object the controller returns and false of everything a client ever sees:
 * `JSON.stringify` renders a `Date` as an ISO string and `JSON.parse` gives a
 * string back. The CLI never had a `Date` at runtime, only in its types and in
 * fixtures the tests hand-built. They are typed as they arrive.
 */

// ---------------------------------------------------------------------------
// GET /import/sources, GET /import/sources/catalog
// Mirrors DataSourceSummary / SourceGuide / SourceCatalogEntry in
// domains/import/services/DataSourceCatalogService.ts
// ---------------------------------------------------------------------------

/** The authored export instructions for one source. */
export interface SourceGuide {
  title: string;
  blurb: string;
  ecosystem: string;
  category: string;
  /** Roughly how long between requesting the export and being able to download it. */
  wait: string;
  /** How the export is obtained: web-export, app-export, local-file, manual-upload, api. */
  acquisition?: string;
  /** Deep link to the export page, when the service has a stable one. */
  url?: string;
  stepsTitle?: string;
  steps: string[];
  /** A second way to get the data, when the service offers one with different tradeoffs. */
  altPath?: { title: string; url?: string; steps: string[] };
  /** What the importer actually reads once the archive is open. */
  expectedFormat?: string;
  /** What lands in the timeline from this source. */
  whatImported?: string[];
  /** Worth knowing BEFORE spending an hour exporting. */
  caveats?: string[];
  /** Loose addenda, rendered without a heading. */
  notes?: string[];
}

/** One importer the appliance ships. IMPORTER-keyed. */
export interface DataSourceSummary {
  /** Stable snake_case id. This is what `staged_items.data_source` records. */
  name: string;
  title: string;
  description: string;
  /** Icon filename the frontend resolves; not a URL. */
  icon: string;
  /** Recognized but not yet implemented — listed rather than hidden. */
  stub: boolean;
  /** Can read an export off disk — the archive-import path. */
  supportsFiles: boolean;
  /** Can pull from a live account, given credentials. */
  supportsApi: boolean;
  guide: SourceGuide | null;
}

/**
 * One authored service. SOURCE-keyed where {@link DataSourceSummary} is
 * IMPORTER-keyed: several services share the `generic` parser, and a service
 * whose importer is not written yet still belongs in the catalog.
 */
export interface SourceCatalogEntry {
  /** Stable authored id (`gmail`, `google_photos`, …). */
  id: string;
  title: string;
  blurb: string;
  ecosystem: string;
  category: string;
  acquisition: string;
  wait: string;
  url?: string;
  stepsTitle?: string;
  steps: string[];
  altPath?: { title: string; url?: string; steps: string[] };
  expectedFormat?: string;
  whatImported?: string[];
  caveats?: string[];
  notes?: string[];
  /** Effective importer name (`importer ?? id`). */
  importer: string;
  importerReady: boolean;
}

// ---------------------------------------------------------------------------
// POST /import/recognize
// Mirrors PathRecognition / PathRecognitionMatch in
// domains/import/datasources/recognizePath.ts
// ---------------------------------------------------------------------------

export interface PathRecognitionMatch {
  dataSource: string;
  title: string;
  confidence: number;
  /** The sub-path that actually matched — for a hit found by descending, the folder to import. */
  matchedPath: string;
}

/**
 * What every parser makes of a path, or why it could not be looked at.
 *
 * `allowed: false` is a RESULT, not an error: the CLI prints the remedy rather
 * than a stack.
 */
export interface PathRecognition {
  allowed: boolean;
  reason?: string;
  path?: string;
  recognized: PathRecognitionMatch[];
}

// ---------------------------------------------------------------------------
// POST /import/uploads
// Mirrors DropSummary in domains/import/controllers/ImportUploadsController.ts
// ---------------------------------------------------------------------------

/** A registered staged upload — bytes landed, nothing unpacked yet. */
export interface DropSummary {
  dropId: string;
  originalFilename: string | null;
  sizeBytes: number | null;
  status: string;
  /** ISO 8601, or null when the drop does not expire. */
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// GET|POST /import/runs, /import/runs/:id, /import/runs/unpushed, /import/push,
// /import/runs/:id/push/retry
// Mirrors RunSummary / StageSummary / RunDetail / UnpushedRunSummary in
// domains/import/controllers/ImportRunsController.ts
// ---------------------------------------------------------------------------

export interface RunSummary {
  id: string;
  label: string | null;
  source: string;
  /** The services this run turned out to contain, most rows first. Empty until parse has run. */
  dataSources: string[];
  /** The importer(s) the wizard's service card stood for. Null when nothing was declared. */
  declaredSources: string[] | null;
  status: string;
  percent: number;
  /** Stage kinds this run intends to execute, so the bar can be drawn on the first poll. */
  requestedStages: string[];
  error: string | null;
  /** ISO 8601. */
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * Rows this run actually WROTE into `ci.*` — the push stage's `detail.pushed`,
   * not its `processed`. Present on the LIST only; zero for a run yet to push.
   */
  records?: number;
}

/** One box of the stage bar. */
export interface StageSummary {
  id: string;
  seq: number;
  kind: string;
  status: string;
  phase: string | null;
  processed: number;
  /** Null means "not yet countable" — draw an indeterminate bar, not 0%. */
  total: number | null;
  weight: number;
  /** Throughput the runner measured, in units of `processed` per second. */
  itemsPerSec: number | null;
  etaSeconds: number | null;
  durationMs: number | null;
  error: string | null;
  detail: Record<string, unknown>;
  /** ISO 8601. `durationMs` is only written when a stage finishes; these are not. */
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunDetail extends RunSummary {
  stages: StageSummary[];
}

/** A run whose parsed rows are waiting for a push, with what is waiting. */
export interface UnpushedRunSummary extends RunSummary {
  pendingItems: number;
  pendingEntities: number;
}

/**
 * POST /import/runs/:runId/push/retry — mirrors the return of
 * `ImportRunsController.retryFailedPush`. `items`/`entities` are the rows moved
 * from `failed` back to `pending`; `requeued` says whether a push was put back
 * on the queue for them (false with zeros means nothing was stranded).
 */
export interface RetryFailedPushResult {
  items: number;
  entities: number;
  requeued: boolean;
}

// ---------------------------------------------------------------------------
// GET /import/inbox, POST /import/inbox/runs
// Mirrors InboxUnit / InboxScan / InboxUnitResult / InboxBatchResult in
// domains/import/services/ImportInboxService.ts
// ---------------------------------------------------------------------------

export interface InboxUnitRecognition {
  dataSource: string;
  title: string;
  confidence: number;
}

/** One importable thing the scan found — a file, or a whole recognized directory. */
export interface InboxUnit {
  /** POSIX path relative to the inbox root: the handle a client sends back. */
  path: string;
  kind: 'file' | 'directory';
  sizeBytes: number;
  fileCount: number;
  recognized: InboxUnitRecognition[];
  /**
   * Display titles of the importers this unit's LOCATION declares — what a drop
   * in this service folder will import as, whatever recognition says. A
   * recognizer cannot see inside a zip, so a `spotify/…zip` unit recognizes as
   * nothing while its import is nonetheless spoken for.
   */
  declared: string[];
  /** An unfinished run of THIS user's already consuming the unit, if any. */
  activeRunId: string | null;
  /**
   * Some run holds this unit, whoever started it. The field to test before
   * offering a unit for import; a foreign run id is deliberately not exposed.
   */
  claimed: boolean;
  /** Sizing stopped at the walk ceiling: `sizeBytes` and `fileCount` are lower bounds. */
  sizeApproximate: boolean;
}

export interface InboxScan {
  available: boolean;
  reason?: string;
  /** The caller's inbox subtree as the API sees it (`CI_IMPORT_INBOX_DIR/<user>`). */
  inboxDir: string;
  /**
   * The same folder as a PERSON reaches it — the host-side spelling of the bind
   * mount. This is what to show someone about to drop files in; `inboxDir` is a
   * path inside the container. Display only; nothing accepts it back.
   */
  displayDir: string;
  units: InboxUnit[];
  skippedSymlinks: number;
  /** UNITS are missing: a walk ceiling dropped top-level entries. */
  truncated: boolean;
  /** Only CHIPS are missing: recognition ran out of time. Nothing importable is hidden. */
  recognitionPartial: boolean;
}

export interface InboxUnitResult {
  unit: string;
  runId?: string;
  label?: string;
  error?: string;
}

export interface InboxBatchResult {
  results: InboxUnitResult[];
}

// ---------------------------------------------------------------------------
// GET /import/doctor, GET /import/doctor/checks
// Mirrors DoctorSeverity / DoctorCheck in domains/import/doctor/checks.ts and
// DoctorStatus / DoctorFinding / DoctorReport in
// domains/import/doctor/ImportDoctorService.ts. `DoctorCheckSummary` is the
// server's `Omit<DoctorCheck, 'sql'>` — the route never sends the predicate.
// ---------------------------------------------------------------------------

export type DoctorSeverity = 'high' | 'medium';

/**
 * What happened to one check.
 *
 * `clean` and `found` are both SUCCESSES — the check ran and returned a number.
 * `timeout` and `error` are the check failing to answer, which is deliberately
 * NOT the same as answering zero.
 */
export type DoctorStatus = 'clean' | 'found' | 'timeout' | 'error';

/** One registered check, as `GET /import/doctor/checks` lists it. */
export interface DoctorCheckSummary {
  /** Stable, kebab-case, never renamed — an agent's loop and a runbook both key on it. */
  id: string;
  severity: DoctorSeverity;
  /** One line, read as: what a NON-ZERO count means. */
  title: string;
  /** The tables scanned. Printed next to a TIMEOUT so the reader knows what was slow. */
  scope: string;
  /** What to do about a non-zero count. */
  remedy: string;
  /** The guard or migration this predicate mirrors, or null where no twin exists. */
  mirrors: string | null;
}

/** One check's result, carrying enough of the check itself to be read standalone. */
export interface DoctorFinding extends DoctorCheckSummary {
  status: DoctorStatus;
  /** Offending rows. Null when the check did not answer (`timeout` / `error`). */
  count: number | null;
  /** `{dimension: n}` — how the count splits. Null when not computed, or nothing found. */
  breakdown: Record<string, number> | null;
  /** One offending row, shape check-specific. Null when nothing was found. */
  sample: Record<string, unknown> | null;
  /** Wall-clock for this statement — the number to look at when it timed out. */
  durationMs: number;
  /** The database's own message, for `timeout` and `error`. Null otherwise. */
  error: string | null;
}

export interface DoctorReport {
  /**
   * The gate. False when any HIGH check found rows, AND when any HIGH check
   * failed to answer.
   */
  ok: boolean;
  at: string;
  durationMs: number;
  /** The per-statement cap in force, echoed so a TIMEOUT is interpretable. */
  statementTimeoutMs: number;
  totals: {
    checks: number;
    clean: number;
    found: number;
    timeout: number;
    error: number;
    /** HIGH checks that found rows. The number the exit code is really about. */
    highFindings: number;
    /** HIGH checks that could not answer. Also fails the gate. */
    highUnresolved: number;
  };
  findings: DoctorFinding[];
}

// ---------------------------------------------------------------------------
// POST /api/maintenance/orchestrate
// Mirrors ORCHESTRATE_STAGES / OrchestrateStage / OrchestrateLegSummary /
// OrchestrateSummary in
// domains/maintenance/services/MaintenanceOrchestratorService.ts
// ---------------------------------------------------------------------------

/**
 * The enrichment legs, in canonical execution order.
 *
 * A request may name any SUBSET, but the server always runs them in THIS order
 * — the legs have real data dependencies (`extract_people` seeds the identifier
 * index `link_communications`/`link_events` resolve against; `materialize_edges`
 * projects what those two filled into `ci.relationships`; `search_index` runs
 * last so the embeds cover the enriched rows).
 *
 * Copied rather than fetched because it is `backfill --list`'s whole vocabulary
 * and `backfill <stage>`'s argument validation, both of which must work against
 * an appliance that is not answering. The server validates the names again on
 * arrival, so a CLI that has drifted gets a 400 that says which name it got
 * wrong — it cannot enqueue a leg this list invented.
 */
export const ORCHESTRATE_STAGES = [
  'extract_people',
  'link_communications',
  'link_events',
  'heal_self_collation',
  'materialize_edges',
  'normalize_relationships',
  'derive_relationships',
  'fold_notes',
  'extract_graph',
  'geocode',
  'reverse_geocode',
  'reverse_position',
  'reverse_object',
  'estimate_locations',
  'media_dimensions',
  'search_index',
  'backfill_summaries',
] as const;

export type OrchestrateStage = (typeof ORCHESTRATE_STAGES)[number];

export interface OrchestrateLegSummary {
  leg: OrchestrateStage;
  ok: boolean;
  result?: object;
  error?: string;
  durationMs: number;
}

/** The terminating `result` frame of the NDJSON stream, and the synchronous body. */
export interface OrchestrateSummary {
  ok: boolean;
  legs: OrchestrateLegSummary[];
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// POST /import/runs — request vocabulary
// Mirrors IMPORT_STAGE_KINDS in domains/import/constants.ts
// ---------------------------------------------------------------------------

/**
 * The stage kinds a run executes, in the order they run.
 *
 * CHECKed in the database (`import_stages.kind`) and permanent: a stage row
 * records the kind that produced it, so renaming one makes every historical run
 * unreadable. Copied for the same reason as {@link ORCHESTRATE_STAGES} — it is
 * what `import --stages` validates against before there is a server to ask.
 */
export const IMPORT_STAGE_KINDS = ['unpack', 'parse', 'media', 'push'] as const;

export type ImportStageKindName = (typeof IMPORT_STAGE_KINDS)[number];

// ---------------------------------------------------------------------------
// GET /v1/ingest/status?scope=appliance
// The ingest domain publishes this shape at runtime; it remains stated here so
// the CLI wire contract does not import the API application.
// ---------------------------------------------------------------------------

/**
 * Row counts of the bulk-ingest destinations plus the search-index side.
 *
 * Every field is optional-safe at the use site so a server that grows a column
 * does not break an older CLI.
 */
export interface IngestStatus {
  tables: Record<string, number>;
  searchIndex: {
    embeddingsByType: Record<string, number>;
    skipsByType: Record<string, number>;
    queue: { created: number; active: number; failed: number };
  };
  at: string;
}
