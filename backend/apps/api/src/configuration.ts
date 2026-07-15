import './bootstrap';

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
  hostname: z.string(),
  logging: z.object({
    level: z.string(),
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
  services: z.object({
    ollama: z.object({
      host: z.string(),
    }),
    hbpe: z.object({
      host: z.string(),
    }),
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
    /** Wholesale gate for the Insights surface (/insights, /insights/:id, /prompts + nav entry points). */
    'insights.page': booleanStringSchema,
    /** Wholesale gate for the Chat page (/chat + nav entry points). */
    'chat.page': booleanStringSchema,
    /** Wholesale gate for the Jobs page (/jobs + nav entry points). */
    'jobs.page': booleanStringSchema,
    /** Enables the memory stats page (`/stats`): timeline totals plus entity
     * breakdowns by data source and by tag. */
    'stats.page': booleanStringSchema,
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
  }),
  environment: z.object({
    'database.query.logging': booleanStringSchema,
  }),
  ciPortal: z.object({
    url: z.string().optional(),
    deviceId: z.string().optional(),
    apiKey: z.string().optional(),
  }),
  // Forward-geocoding (geodata-plan Phase 1). The key is read from
  // GEOCODING_API_KEY, falling back to the legacy GOOGLE_MAPS_KEY (see
  // custom-environment-variables.json + the fallback transform below).
  geocoding: z.object({
    apiKey: z.string().optional(),
    batchSize: z.coerce.number().int().positive().default(200),
    rateLimitPerSecond: z.coerce.number().int().positive().default(10),
  }),
});

const parsed = ConfigSchema.parse(config);

// The embedder follows the main Ollama host unless an explicit embedding host is
// configured (OLLAMA_EMBED_HOST), so a GPU/alternate-host Ollama can be pointed
// at for embeddings only without touching the prompt/inference host.
if (!parsed.embedding.host) {
  parsed.embedding.host = parsed.services.ollama.host;
}

// GEOCODING_API_KEY takes precedence; fall back to the legacy GOOGLE_MAPS_KEY so
// existing deployments keep working until the billed key is supplied. (config's
// custom-environment-variables.json maps one env var per field, not a fallback
// chain — so the OR lives here.)
if (!parsed.geocoding.apiKey && process.env.GOOGLE_MAPS_KEY) {
  parsed.geocoding.apiKey = process.env.GOOGLE_MAPS_KEY;
}

if (!parsed.geocoding.apiKey) {
  // Warn (don't throw): the server must still boot without a geocoding key; the
  // backfill simply no-ops / returns REQUEST_DENIED until one is configured.
  console.warn(
    '[configuration] No geocoding API key configured (GEOCODING_API_KEY / GOOGLE_MAPS_KEY). ' +
      'Forward-geocode backfills will be skipped until one is set.',
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
