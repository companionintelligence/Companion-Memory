import './bootstrap';

import path from 'node:path';

import config from 'config';
import { z } from 'zod';

const booleanStringSchema = z.preprocess((val) => {
  if (val === 'true') {
    return true;
  }

  if (val === 'false') {
    return false;
  }

  return val;
}, z.boolean());

export const ConfigSchema = z.object({
  host: z.string(),
  port: z.number(),
  /**
   * Which half of the appliance this process is. `all` (the default) is the
   * single-process topology: HTTP plus every queue and cron — standalone dev
   * and role-less deployments keep working untouched. `web` serves HTTP and
   * everything EXCEPT the queues/crons marked for the worker; `worker` is a
   * headless process serving exactly those. The split exists because import
   * stage jobs run long synchronous parser stretches, and sharing an event
   * loop with interactive requests makes buttons hang.
   */
  role: z.enum(['all', 'web', 'worker']).default('all'),
  hostname: z.string(),
  logging: z.object({
    level: z.string(),
  }),
  // Cross-origin allowlist for non-same-origin clients — notably the native
  // Capacitor app, whose webview origin is capacitor://localhost (iOS) or
  // http(s)://localhost (Android). The web app is served same-origin behind the
  // proxy and needs no entry here. The fixed native origins are always allowed in
  // main.ts; this list is the operator-extensible addition, parsed from a
  // comma-separated CORS_ALLOWED_ORIGINS env var.
  cors: z.object({
    allowedOrigins: z.preprocess((val) => {
      if (typeof val === 'string') {
        return val
          .split(',')
          .map((o) => o.trim())
          .filter((o) => o.length > 0);
      }

      return val;
    }, z.array(z.string()).default([])),
  }),
  auth: z.object({
    local: z.object({
      saltRounds: z.number(),
    }),
    jwt: z.object({
      authTokenSecret: z.string(),
      authTokenExpiration: z.string(),
      refreshTokenSecret: z.string(),
      refreshTokenExpiration: z.string(),
    }),
    // CI-Portal as the OIDC identity provider. When enabled, CI-Server accepts
    // portal-issued JWTs (validated via the portal JWKS) alongside its own
    // tokens, and JIT-provisions the matching user. See
    // CI-Engineering/architecture/unified-identity-pipeline.md.
    portal: z.object({
      enabled: z.boolean(),
      issuer: z.string(),
      jwksUri: z.string(),
      audience: z.string(),
    }),
    // Traefik forward-auth identity header signed by CI-Hub. When enabled, the
    // server verifies the HMAC-SHA256 signature on X-CI-Hub-User before trusting
    // it (shared secret provisioned as CI_HUB_FORWARD_AUTH_SECRET on both sides).
    // Off by default so local/tailscale-exposed apps (which get no forward-auth
    // from Traefik) keep working. See CI-Engineering/architecture/subsystems/
    // security-trust-and-ops.md.
    hubForwardAuth: z.object({
      enabled: z.boolean(),
      secret: z.string(),
      maxSkewMs: z.coerce.number().int().positive(),
    }),
    session: z.object({
      fieldPepper: z.string(),
      duration: z.string(),
      refreshGracePeriod: z.string(),
    }),
    csrf: z.object({
      secret: z.string(),
    }),
    encryption: z.object({
      fieldKey: z
        .string()
        .regex(/^[0-9A-Fa-f]{64}$/, 'fieldKey must be a 64-character hex string (256 bits)'),
    }),
    cookies: z.object({
      sessionTokenName: z.string(),
      csrfTokenName: z.string(),
    }),
    providers: z.object({
      google: z.object({
        id: z.string(),
      }),
      microsoft: z.object({
        id: z.string(),
      }),
      facebook: z.object({
        id: z.string(),
      }),
      github: z.object({
        id: z.string(),
      }),
      spotify: z.object({
        id: z.string(),
      }),
      steam: z.object({
        id: z.string(),
      }),
      signal: z.object({
        id: z.string(),
      }),
    }),
    openid: z.object({
      callbackUrl: z.string(),
    }),
    oauth: z.object({
      callbackUrl: z.string(),
    }),
    oidc: z.object({
      issuerUrl: z.string(),
      // Public origin of this app (e.g. https://ci-memory-<org>.companionintelligence.com),
      // injected by CI-Hub as APP_BASE_URL. When set, the OIDC redirect_uri is built from
      // this stable origin instead of the inbound request host — so reaching the app at its
      // local *.localhost route still yields a publicly-reachable callback for CI-Portal.
      publicBaseUrl: z.string().optional().default(''),
      // Custom URL scheme the native (Capacitor) app registers so the OIDC callback
      // can deep-link the sign-in result back into the app. Must match the scheme in
      // the iOS Info.plist / Android intent-filter and @ci/common's OIDC_NATIVE_SCHEME.
      // Validated as an RFC-3986 scheme token (letter, then letters/digits/+/-/.) so a
      // misconfigured value (empty, contains `://`, …) fails fast instead of silently
      // producing a broken `${scheme}://oidc/callback` deep link.
      nativeRedirectScheme: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9+.-]*$/, 'must be a valid URL scheme, e.g. "companion"')
        .default('companion'),
    }),
    // App-connect flow (CI-Hub brokers connecting agent apps to Companion Memory).
    // `hubOrigins` is a comma-separated allowlist of CI-Hub origins that the
    // consent flow is permitted to redirect back to after minting a scoped key —
    // an open-redirect guard for the one cross-origin hop. Injected by CI-Hub as
    // CI_HUB_ORIGINS at install. Empty disables the connect redirect entirely.
    connect: z.object({
      hubOrigins: z.string().optional().default(''),
    }),
  }),
  db: z.object({
    type: z.literal('postgres'), // restrict to 'postgres' (or z.string() for other DBs)
    host: z.string(),
    port: z.coerce.number().int(),
    database: z.string(),
    username: z.string(),
    password: z.string(),
  }),
  staticfiles: z.object({
    storageUrl: z.string(),
    region: z.optional(z.string()),
    bucket: z.string(),
    auth: z.object({
      signatureUrl: z.optional(z.string()),
      signatureTTL: z.number(),
      accessKeyId: z.string(),
      secretAccessKey: z.string(),
    }),
  }),
  graphql: z.object({
    maxQueryComplexity: z.number().int(),
  }),
  // OpenAI-compatible chat backend (Hub-injected LLM_* env, or Settings → Model).
  // When the chat port differs from Ollama's, the NestJS chat path speaks OpenAI
  // protocol (vLLM, etc.); embeddings continue to use OLLAMA_HOST / OLLAMA_EMBED_HOST.
  llm: z
    .object({
      apiBase: z.string().optional(),
      apiKey: z.string().default('ollama'),
      chatModel: z.string().default('gemma3:1b'),
    })
    .default({}),
  // Local-first sync (PowerSync). The server issues short-lived client tokens via
  // /api/powersync/token; the sync engine runs in the `powersync` container. Empty
  // url/jwtSecret = feature scaffolded but not enabled (the endpoint returns 503).
  // See infrastructure/powersync/README.md.
  powersync: z.object({
    /** Public URL of the PowerSync service the client connects to. */
    url: z.string().default(''),
    /** Shared HS256 secret the PowerSync service's client_auth trusts. */
    jwtSecret: z.string().default(''),
    /** Audience claim the PowerSync service expects. */
    audience: z.string().default('powersync'),
    /** Client token lifetime (the SDK refreshes via fetchCredentials). */
    tokenTtl: z.string().default('300s'),
    /** Key id set in the JWT header, matched against the PowerSync jwks entry. */
    jwtKid: z.string().default('ci-powersync-hs256'),
  }),
  services: z.object({
    ollama: z.object({
      host: z.string(),
    }),
    hbpe: z.object({
      host: z.string(),
    }),
    parser: z.object({
      host: z.string(),
    }),
    /**
     * Summary service API (function runner + manual triggers). Distinct from
     * `parser`, which is the document-parsing app on a different port of the
     * same container.
     */
    summary: z.object({
      host: z.string().default('http://summary-service:8001'),
    }),
  }),
  signalCli: z.object({
    restUrl: z.string(),
  }),
  // Embedding/indexing pipeline knobs. These let a deployment point the embedder
  // at a GPU/alternate-host Ollama and tune throughput for bulk imports without
  // code changes. `host` defaults to services.ollama.host (resolved below) so the
  // embedder follows the main Ollama host unless OLLAMA_EMBED_HOST overrides it.
  embedding: z.object({
    /** Ollama host used for embedding calls. Falls back to services.ollama.host. */
    host: z.string().optional(),
    /** Embedding model name (must match the pgvector column dimensionality). */
    model: z.string().default('nomic-embed-text'),
    /** Max texts sent to Ollama's /api/embed in a single HTTP request. */
    batchSize: z.coerce.number().int().positive().default(32),
    /** Max concurrent in-flight Ollama embedding HTTP requests. */
    concurrency: z.coerce.number().int().positive().default(12),
    /**
     * How long (ms) the coalescing buffer waits for more texts before flushing a
     * batch. Small values keep latency low; larger values pack fuller batches
     * during a bulk import. 0 disables coalescing (flush on next tick).
     */
    coalesceWindowMs: z.coerce.number().int().nonnegative().default(15),
    /** Texts shorter than this (after trim) are skipped (selective embedding). */
    minTextLength: z.coerce.number().int().nonnegative().default(3),
    /**
     * Entity types eligible for dense embedding. Empty array = embed all types
     * (the conservative default — nothing is silently dropped by type). Set
     * CI_EMBED_TYPES to a comma-separated allowlist to restrict embedding to
     * specific types (keyword/tsvector indexing is unaffected).
     */
    types: z.preprocess((val) => {
      if (typeof val === 'string') {
        return val
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
      }

      return val;
    }, z.array(z.string()).default([])),
  }),
  // PGBoss worker tuning. concurrency is the GLOBAL in-flight job ceiling across
  // all queues; fetchBatchSize caps how many jobs a single fetch pulls;
  // perQueueConcurrency caps how many jobs any ONE queue may run at once. The
  // per-queue cap is sized below the global ceiling so a burst of slow jobs on
  // one queue (image-description / embedding on the shared Ollama host) can no
  // longer monopolize the global pool and starve another queue — the observed
  // search-index backlog stall. Raise CI_QUEUE_CONCURRENCY / CI_EMBED_CONCURRENCY
  // (and CI_QUEUE_SUPPRESS the enrichment queues) to push a large import harder.
  queues: z.object({
    concurrency: z.coerce.number().int().positive().default(32),
    fetchBatchSize: z.coerce.number().int().positive().default(20),
    perQueueConcurrency: z.coerce.number().int().positive().default(6),
  }),
  // The archive importer's working directory. A run downloads its uploaded
  // archive here, extracts it, and parses the resulting tree; the whole
  // directory is reclaimed when the run finishes.
  //
  // Configurable because the default is a trap at real sizes. An unpacked Google
  // Takeout runs 40-50GB and `/tmp` is tmpfs on a stock appliance, so extracting
  // there consumes RAM until the machine dies. Deployments point this at the
  // same volume the object store uses.
  import: z
    .object({
      scratchDir: z.string().default('/var/tmp/ci-import'),
      // Directories the path-based import tools may read. EMPTY BY DEFAULT: an
      // unconstrained absolute path over an API is a filesystem read primitive,
      // so path imports stay off until an operator names the directory that holds
      // exports. Uploading through the API is unaffected. Files here are the
      // user's own and are never modified or deleted.
      roots: z.array(z.string()).default([]),
      // Where uploads are staged: <uploadsDir>/<dropId>/<filename>, registered
      // in ci_import.staged_sources with a TTL. Importer-owned and root-only —
      // unlike the inbox, nothing lands here except through the API. Should
      // share a filesystem with scratchDir so consuming an upload is an atomic
      // rename.
      uploadsDir: z.string().default('/var/lib/ci-import/uploads'),
      // The import inbox — the folder a user moves export archives into.
      // Everything in it is a copy staged for import: a batch run consumes it
      // (the unpack stage moves it into the run's scratch) and the bytes are
      // deleted with the completed run. Non-empty by default, unlike `roots`,
      // because the folder only holds what a user deliberately put there, and
      // compose ships the mount; an absent directory just scans as unavailable.
      inboxDir: z.string().default('/var/lib/ci-import/inbox'),
      // Zip-bomb guards on extraction. These are a ceiling on what an archive
      // may expand to, NOT a statement about what this appliance imports: the
      // uploads controller accepts 50GiB precisely because "Google Takeout
      // splits run 40-50GB", and a photo Takeout routinely carries several
      // hundred thousand files. The previous defaults — 100k entries and 10GB —
      // rejected exactly the archives the rest of the import path is built to
      // handle, with no way to raise them. Path containment is asserted per
      // entry regardless and is not affected by either number.
      maxArchiveEntries: z.coerce.number().int().positive().default(2_000_000),
      maxArchiveBytes: z.coerce
        .number()
        .int()
        .positive()
        .default(100 * 1024 ** 3),
    })
    .superRefine((value, context) => {
      // The three areas have different owners and different sweeps: the inbox
      // is world-writable and user-facing, uploads are root-only and TTL'd,
      // scratch belongs to runs. Nesting any inside another crosses those
      // contracts — uploads under the inbox would expose every user's staged
      // uploads through the inbox scan.
      const dirs: Array<[string, string]> = [
        ['scratchDir', path.resolve(value.scratchDir)],
        ['uploadsDir', path.resolve(value.uploadsDir)],
        ['inboxDir', path.resolve(value.inboxDir)],
      ];

      for (const [aName, a] of dirs) {
        for (const [bName, b] of dirs) {
          if (aName === bName) {
            continue;
          }

          const relative = path.relative(a, b);

          if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `import.${bName} must not be inside import.${aName} (${b} is under ${a})`,
            });
          }
        }
      }
    }),
  // WHEN the appliance is willing to spend on enrichment, and HOW MUCH. The
  // pipeline's twelve stages share ONE Ollama process with interactive chat,
  // HBPE and the summary sidecar, and two of them egress to a metered geocoding
  // provider — so background enrichment is not free-running work, it is a
  // nightly allowance with an owner-visible cost. `window` bounds the hours;
  // `rotation` decides who inside them gets served. Consumed by
  // `domains/pipeline/constants.ts` → `EnrichmentWindowService`, which explains
  // every number. Defaults suit an appliance whose owner is asleep.
  enrichment: z.object({
    window: z.object({
      /**
       * Off makes enrichment free-running again — the pre-window behaviour, and
       * the right setting for a supervised first-import burn-in where somebody
       * is watching the box and wants the archive processed today.
       */
      enabled: booleanStringSchema.default(true),
      /** Local wall-clock time the window opens, `HH:MM`, 24-hour. */
      start: z
        .string()
        .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be a 24-hour HH:MM local time, e.g. "01:00"')
        .default('01:00'),
      /** How long the window stays open. May cross midnight. */
      durationMinutes: z.coerce
        .number()
        .int()
        .positive()
        .max(24 * 60)
        .default(300),
      /**
       * Minutes of ACTUAL enrichment activity the appliance will spend inside
       * the window. Distinct from the window length on purpose: the window is
       * permission (do not run while the owner is awake), the budget is spend
       * (do not be a permanent background tenant). A night with nothing to do
       * costs nothing, and a box that boots at 03:00 still gets its full budget.
       */
      budgetMinutes: z.coerce
        .number()
        .int()
        .positive()
        .max(24 * 60)
        .default(90),
      /**
       * IANA zone the window's wall clock is read in. Empty = the host's zone,
       * which on an appliance is the owner's.
       */
      timezone: z.string().default(''),
    }),
    rotation: z.object({
      /**
       * How long one user holds the window before it passes to the
       * least-recently-served user. This is the bound on how long user 2 waits
       * behind user 1's archive: one turn, not one import.
       */
      turnMinutes: z.coerce.number().int().positive().default(20),
      /**
       * Users served concurrently. 1 by default: the appliance-wide sweep and
       * queue-depth caps are already the ceiling, so splitting them across
       * users makes every user slower without making anyone earlier.
       */
      usersPerTurn: z.coerce.number().int().positive().default(1),
    }),
  }),
  features: z.object({
    'scheduled.answer.inferencing': booleanStringSchema,
    'scheduled.connection.sync': booleanStringSchema,
    'scheduled.entity.promotion': booleanStringSchema,
    'pinned.demo.models': booleanStringSchema,
    'enable.system.prompt': booleanStringSchema,
    'enable.inventory.page': booleanStringSchema,
    'advanced.theme.tab': booleanStringSchema,
    'new.insights.page': booleanStringSchema,
    'require.signup.codes': booleanStringSchema,
    'files.page': booleanStringSchema,
    /** The archive-import surface (/import): upload, run progress, the source catalogue and the guide. */
    'import.page': booleanStringSchema,
    /** Wholesale gate for the Insights surface (/insights, /insights/:id, /prompts + nav entry points). */
    'insights.page': booleanStringSchema,
    /** Wholesale gate for the Chat page (/chat + nav entry points). */
    'chat.page': booleanStringSchema,
    /** Wholesale gate for the Jobs page (/jobs + nav entry points). */
    'jobs.page': booleanStringSchema,
    /**
     * Backend gate for the planning domain: ci.tasks, planned-block events and
     * the planning GraphQL surface. See docs/architecture/planning-roadmap.md.
     */
    'planning.enabled': booleanStringSchema,
    /** Wholesale gate for the Plan page (/plan + nav entry points). */
    'planning.page': booleanStringSchema,
    /** Shows the "Nothing planned yet" empty state on the Plan page when there are no tasks. */
    'planning.emptyState': booleanStringSchema,
    /** Enables the memory stats page (`/stats`): timeline totals plus entity
     * breakdowns by data source and by tag. */
    'stats.page': booleanStringSchema,
    /** Wholesale gate for the Schedule surface (`/schedule` + nav entry point):
     * committed events, the HBPE rhythm layer, and proposed candidates. Off by
     * default while the proposer is still being tuned. */
    'schedule.page': booleanStringSchema,
    /** The standalone all-tags browse page (`/tags`). Restored — on by default —
     * after #1512 removed it and left no way to see every tag in the system.
     * Chips open the explorer filtered by the tag (`/memory?tags=<label>`). */
    'tags.page': booleanStringSchema,
    hbpe: booleanStringSchema,
    /** Enables the memory compaction cron that promotes note fragments into graph entities. */
    'agent.memory.compaction': booleanStringSchema,
    /**
     * Enables saved-search sharing: the `/shared/<token>` capability-link path
     * (resolving a shared saved search and running it as its owner) and the
     * frontend "make public" control. Off by default — the access model is still
     * being hardened, so the shared-URL surface stays dark unless explicitly
     * enabled.
     */
    'shared.search': booleanStringSchema,
    /** Shows would-you-rather preference steps during onboarding (food/movie/activity). */
    'onboarding.preference.steps': booleanStringSchema,
    /**
     * Wholesale gate for the Actions system: feed action cards, action GraphQL/REST,
     * feed badge contribution from actions, and the deferred (~24h post-setup) seed
     * initializer. On by default; set ENABLE_ACTIONS=false to disable.
     */
    actions: booleanStringSchema,
    /**
     * Meta flag for background intelligence scheduling. When on, each pipeline
     * (question feed, answer inference, schedule sync, insights, summaries,
     * graph enrichment) runs on its own cadence via SmartRotationScheduledCrons
     * instead of the legacy standalone crons.
     */
    'smart.rotation': booleanStringSchema,
  }),
  environment: z.object({
    'database.query.logging': booleanStringSchema,
  }),
  ciPortal: z.object({
    url: z.string().optional(),
    deviceId: z.string().optional(),
    apiKey: z.string().optional(),
  }),
  // Geocoding, both directions (address <-> coordinates). Egress normally goes
  // through CI-Portal, which holds the provider key and fronts a cache shared by
  // every appliance; `google` is the direct-key fallback and is the only mode
  // that reads `apiKey` (GEOCODING_API_KEY, falling back to the legacy
  // GOOGLE_MAPS_KEY — see custom-environment-variables.json + the transform below).
  geocoding: z.object({
    apiKey: z.string().optional(),
    batchSize: z.coerce.number().int().positive().default(200),
    rateLimitPerSecond: z.coerce.number().int().positive().default(10),
    /**
     * Which implementation backs the GEOCODE_PROVIDER token.
     *   portal (default) — proxy through CI-Portal; no provider key on the box.
     *   google           — call Google directly with `apiKey`; kept as a fallback
     *                      for deployments with no Portal reachability.
     */
    provider: z.enum(['portal', 'google']).default('portal'),
    /**
     * Base origin of the geocoding proxy — CI-Portal itself, or the hub host
     * that fronts it. WHICH of the two a deployment uses is still undecided, so
     * this is the single knob that answers it and the only place a Portal URL is
     * configured for geocoding. Defaults to ciPortal.url (CI_CLOUD_URL) below,
     * so a box that already talks to Portal needs no extra env var; set
     * GEOCODING_PORTAL_BASE_URL to route via the hub instead.
     */
    portalBaseUrl: z.string().default(''),
  }),
});

const parsed = ConfigSchema.parse(config);

// The embedder follows the main Ollama host unless an explicit embedding host is
// configured (OLLAMA_EMBED_HOST), so a GPU/alternate-host Ollama can be pointed
// at for embeddings only without touching the prompt/inference host.
if (!parsed.embedding.host) {
  parsed.embedding.host = parsed.services.ollama.host;
}

if (!parsed.llm.apiBase) {
  parsed.llm.apiBase = undefined;
}

if (!parsed.llm.apiKey) {
  parsed.llm.apiKey = 'ollama';
}

if (!parsed.llm.chatModel) {
  parsed.llm.chatModel = 'gemma3:1b';
}

// GEOCODING_API_KEY takes precedence; fall back to the legacy GOOGLE_MAPS_KEY so
// existing deployments keep working until the billed key is supplied. (config's
// custom-environment-variables.json maps one env var per field, not a fallback
// chain — so the OR lives here.)
if (!parsed.geocoding.apiKey && process.env.GOOGLE_MAPS_KEY) {
  parsed.geocoding.apiKey = process.env.GOOGLE_MAPS_KEY;
}

// The geocoding proxy follows the Portal URL the box already uses unless an
// explicit base URL is configured (GEOCODING_PORTAL_BASE_URL), so routing
// geocoding via the hub host instead of Portal directly is a one-variable
// change. Same shape as the embedding-host fallback above: the OR lives here so
// the provider reads exactly one config value.
if (!parsed.geocoding.portalBaseUrl) {
  parsed.geocoding.portalBaseUrl = parsed.ciPortal.url ?? '';
}

// Warn (don't throw) on a geocoding misconfiguration: the server must still
// boot, and the backfill simply reports a transient/denied status until it is
// fixed. Each provider has its own requirement, so only warn about the one in use.
if (parsed.geocoding.provider === 'google' && !parsed.geocoding.apiKey) {
  console.warn(
    '[configuration] geocoding.provider is "google" but no API key is configured ' +
      '(GEOCODING_API_KEY / GOOGLE_MAPS_KEY). Geocode backfills will be skipped until one is set.',
  );
}

if (parsed.geocoding.provider === 'portal' && !parsed.geocoding.portalBaseUrl) {
  console.warn(
    '[configuration] geocoding.provider is "portal" but no base URL is configured ' +
      '(GEOCODING_PORTAL_BASE_URL / CI_CLOUD_URL). Geocode backfills will report a transient ' +
      'failure until one is set.',
  );
}

// The field-encryption key protects OAuth access/refresh tokens and provider
// client secrets at rest. The config default is 64 hex zeros — valid by format
// but cryptographically useless. Surface it loudly (like the geocode key) so it
// is never silently run in a real deployment. Refuse to boot outside dev.
if (/^0{64}$/i.test(parsed.auth.encryption.fieldKey)) {
  const msg =
    '[configuration] FIELD_ENCRYPTION_KEY is the all-zero default — OAuth tokens and ' +
    'provider client secrets would be encrypted with a well-known key. Set a real 256-bit key.';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(msg);
  }

  console.warn(msg);
}

export default parsed;
