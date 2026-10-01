import './bootstrap';

import path from 'node:path';

import config from 'config';
import { z } from 'zod';

import { isDeclaredEmbedModel } from './common/embeddings/embedModelIdentity';
import { resolveLlmUrlForRuntime } from './domains/llm/services/llmEndpointShared';

/**
 * The chat model an appliance uses when nothing overrides it.
 *
 * Every LLM-backed feature that is not handed an explicit model lands here:
 * thread titling, task breakdown, the derivation narrators, the import
 * enrichers. It is the floor those features are judged against, so a default
 * too weak to hold a JSON schema does not degrade them — it silently disables
 * them, because their fallback is deterministic ordering or no output at all.
 *
 * `gemma3:1b` was that floor and had aged into exactly this failure: 815MB and
 * measurably unable to keep to a schema (see TaskBreakdownService), while
 * CI-Planning had already moved its quality tier to an e4b-class model. Kept as
 * the shipped default it made "the feature is on" and "the feature works"
 * different claims.
 *
 * `gemma4:e4b` is the modern equivalent of that tier — and deliberately the
 * EFFICIENT variant, not `gemma4:31b`: this ships to appliances that also hold
 * an embedding model, HBPE and the summary sidecar in the same GPU, and a
 * default is a floor everyone pays for, not a ceiling for the best-provisioned
 * box. Override with `LLM_DEFAULT_CHAT_MODEL` (or Settings → Model); the Hub
 * injects its own on managed deployments.
 *
 * Changing this means changing the model `make health` requires, since a
 * default nobody has pulled fails at first use rather than at setup.
 */
export const DEFAULT_CHAT_MODEL = 'gemma4:e4b';

/**
 * Model for BACKGROUND inference — extraction, classification, JSON shaping —
 * as opposed to the model a person is talking to.
 *
 * These are two different jobs and they want opposite things. An operator picks
 * `LLM_DEFAULT_CHAT_MODEL` for conversational quality and will happily set a
 * 31B model for it. Background jobs want a model that returns grammar-
 * constrained JSON quickly, and are ruined by a large one: measured on a real
 * appliance, an identical ~1170-token extraction prompt took over 170 seconds
 * on `gemma4:31b` (never returned inside the job's timeout) and 3.6 seconds on
 * a 1B model — INCLUDING its cold load — with correct, schema-valid output.
 * The cost is dominated by prompt evaluation, so no output cap or longer
 * timeout can rescue it; only a smaller model can.
 *
 * Before this existed both jobs read `llm.chatModel`, so raising the chat model
 * for quality silently broke every background job on the appliance. The
 * planning scans failed that way indefinitely, logging a generic LLM timeout
 * that named neither the model nor the real cause. Several of those services
 * were even written ASSUMING this was small — see `TaskBreakdownService`'s
 * "a small `PROMPT_MODEL` reliably [invents key names]".
 *
 * Defaults to {@link DEFAULT_CHAT_MODEL} so a deployment that never sets it
 * behaves exactly as it did before, rather than suddenly pulling a model the
 * box has not got.
 */
export const DEFAULT_UTILITY_MODEL = DEFAULT_CHAT_MODEL;

const booleanStringSchema = z.preprocess((val) => {
  if (val === 'true') {
    return true;
  }

  if (val === 'false') {
    return false;
  }

  return val;
}, z.boolean());

/**
 * Is this URL empty, or unambiguously on this machine?
 *
 * Hostname-only, and an allowlist rather than a pattern: `127.0.0.1.evil.com`
 * and `localhost.attacker.net` both CONTAIN a loopback string and resolve
 * wherever their owner points them. A URL that does not parse is not loopback
 * either.
 */
export function isEmptyOrLoopback(value: string): boolean {
  if (value === '') {
    return true;
  }

  try {
    const { hostname } = new URL(value);

    return ['127.0.0.1', '::1', '[::1]', 'localhost', 'host.docker.internal'].includes(hostname);
  } catch {
    return false;
  }
}

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
      /**
       * Optional Portal (or Lifescope) push relay. The appliance stores device
       * tokens but must not hold the app's APNs/FCM key; when set, token writes
       * are forwarded here. Empty = local notifications only.
       */
      pushRelayUrl: z.string().default(''),
      // Comma-separated OAuth client ids allow-listed as service accounts (e.g.
      // "hbpe-sidecar,summary-sidecar"). A Portal-signed token presenting one of
      // these client ids is treated as a Portal-brokered service credential: it
      // acts on behalf of the user named in its `sub` claim instead of being
      // JIT-provisioned as a human login. Replaces the shared HS256 secret the
      // sidecars used to self-sign with. See unified-identity-plan.md · B5.
      serviceClients: z.string().default(''),
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
    // Brute-force throttle on the local password login. An appliance is a single
    // account behind a single password on a box its owner may well have exposed
    // to a tailnet or the internet, so unlimited guesses is the whole attack.
    // On by default; the numbers are a per-identity budget, not a global one.
    loginThrottle: z.object({
      /** Off restores the pre-throttle behaviour: unlimited login attempts. */
      enabled: booleanStringSchema.default(true),
      /** Failed attempts allowed inside `windowSeconds` before the lockout starts. */
      maxAttempts: z.coerce.number().int().positive().default(10),
      /** Rolling window the failures are counted over. */
      windowSeconds: z.coerce.number().int().positive().default(900),
      /** How long further attempts are refused once the budget is spent. */
      lockoutSeconds: z.coerce.number().int().positive().default(900),
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
      reddit: z.object({
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
      slack: z.object({
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
      // Docker-network origin Memory uses to ring Hub's targeted wake. The
      // public CI_HUB_ORIGINS list is for browser redirects; this is the
      // appliance-local hop. Override with CI_HUB_INTERNAL_URL.
      hubInternalUrl: z.string().optional().default('http://ci-os-hub:3000'),

      /**
       * DEV ONLY. Ring OpenClaw's `/hooks/wake` directly, skipping Hub.
       *
       * A local dev stack cannot reach Hub — `CI_HUB_INTERNAL_URL` names a
       * Docker alias no CI-Server compose file defines, and
       * `CI_HUB_FORWARD_AUTH_SECRET` is empty — so dispatch could not be
       * exercised at all without a full Hub install: a private-registry token,
       * a source build, Postgres + RabbitMQ, and OpenClaw installed THROUGH
       * Hub, because Hub resolves wake targets only from installed app files.
       *
       * Skipping Hub is safe here because the wake is a DOORBELL, not a grant.
       * The body carries no secret; all authority lives in the packet fetch the
       * harness then makes with its own user-scoped key, and `getPacket` scopes
       * the row by `{ id, userId }`. Hub's own leg to OpenClaw is already a
       * plain shared bearer rather than a signature, so nothing cryptographic
       * is given up. What IS given up is Hub's policy point — it decides which
       * apps may be woken at all — and its sole custody of the wake token.
       * That is why this is dev-only.
       *
       * LOOPBACK-ENFORCED AT PARSE TIME, deliberately. The one way this could
       * weaken anything real is misactivation: an appliance that somehow had it
       * set would POST a bearer to whatever host it named. Refusing to boot
       * beats warning about it.
       */
      devDirectWakeUrl: z.string().optional().default('').refine(isEmptyOrLoopback, {
        message:
          'CI_DEV_DIRECT_WAKE_URL must be loopback (127.0.0.1, ::1, localhost or host.docker.internal). It exists to exercise dispatch on a dev stack and must never point off-box.',
      }),

      /** The static bearer OpenClaw's `/hooks/wake` compares — its `HUB_WAKE_SECRET`. */
      devDirectWakeToken: z.string().optional().default(''),
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
    /**
     * Maximum GraphQL query nesting depth; complements the existing complexity
     * ceiling. Complexity alone does not bound recursion — a deeply nested but
     * cheap-looking selection can still be walked by the resolver layer — so the
     * two limits are enforced together.
     */
    maxDepth: z.coerce.number().int().positive().default(12),
  }),
  // OpenAI-compatible chat backend (Hub-injected LLM_* env, or Settings → Model).
  // When the chat port differs from Ollama's, the NestJS chat path speaks OpenAI
  // protocol (vLLM, etc.). Embeddings follow it when it serves the embedder, else
  // OLLAMA_HOST; LLM_EMBEDDING_API_BASE pins them (EmbeddingGenerationService.resolveTarget).
  llm: z
    .object({
      apiBase: z.string().optional(),
      apiKey: z.string().default('ollama'),
      chatModel: z.string().default(DEFAULT_CHAT_MODEL),
      /** Background extraction/classification model. See {@link DEFAULT_UTILITY_MODEL}. */
      utilityModel: z.string().default(DEFAULT_UTILITY_MODEL),
      /**
       * How long one model request may go without ANY response — no headers,
       * no first token — before it is torn down (`firstResponseDeadline.ts`).
       * Bounds the wait for a runner that never comes (a model swap the
       * scheduler cannot make, a wedged backend), not the generation: once the
       * backend starts answering the deadline no longer applies. Before this
       * the only bound was undici's five-minute headers timeout, and pg-boss's
       * 15-minute job expiry did the rest. Sized above the longest legitimate
       * wait for a busy single-slot runner; a request cut here is retried, so
       * too short costs churn, too long costs a person's patience.
       */
      firstResponseTimeoutMs: z.coerce.number().int().positive().default(90_000),
      chat: z
        .object({
          groundedRecall: z
            .object({
              /**
               * When on, a chat turn pre-runs memory recall for the latest user
               * message and inserts the result into the fenced turn-context
               * block instead of relying on the model to call a tool.
               */
              enabled: booleanStringSchema.default(true),
            })
            .default({}),
        })
        .default({}),
      /**
       * Model-tier routing (`domains/model-routing`, `ModelTierRouter`) applied to
       * chat model selection in `OllamaService.resolveModel`.
       *
       * OFF by default and deliberately so: the router's on-device context window
       * (8K) is an estimate mirroring Apple's on-device/PCC split, not a measured
       * property of whatever the appliance is serving. With `enabled: false`
       * `resolveModel` behaves exactly as it did before routing existed.
       */
      tierRouting: z
        .object({
          /** Consult `ModelTierRouter` when choosing the chat model. */
          enabled: z.boolean().default(false),
          /**
           * Model id to use for the `on_device` tier. Empty = keep the model the
           * existing served-model resolution picked.
           */
          onDeviceModel: z.string().default(''),
          /**
           * Model id to use for the escalated `private_cloud` tier. Empty means the
           * escalated tier has no target, so the router is told the cloud tier is
           * unavailable and every task stays on-device.
           */
          escalatedModel: z.string().default(''),
          /**
           * Real usable context window of `onDeviceModel`, in tokens. Overrides the
           * router's estimated 8K so the escalation threshold is a deployment fact
           * rather than a guess. 0 = fall back to the router's own profile.
           */
          onDeviceContextTokens: z.number().int().nonnegative().default(0),
        })
        .default({}),
      /**
       * GPU co-residency planning for the utility model
       * (`domains/llm/services/ResidencyPlannerService.ts`).
       *
       * Before this existed every background call asked Ollama to load
       * `utilityModel` at Ollama's default context, and Ollama decided whether
       * it fit from its own prediction. When it did not, Ollama tried to evict
       * the chat model — which a busy appliance never lets go idle — and every
       * request for a non-resident model queued behind that wait, silently.
       * The planner reads live GPU memory and refuses to start a load it cannot
       * prove fits, routing that call to the resident chat model instead.
       */
      residency: z
        .object({
          /** `off` restores the old behaviour: the configured utility model, unplanned, no `num_ctx`. */
          mode: z.enum(['auto', 'off']).default('auto'),
          /**
           * Total GPU memory, in bytes, for machines where neither the AMD sysfs
           * counters nor `nvidia-smi` are readable from this process. 0 = unknown,
           * and an unknown total routes every utility call to the chat model
           * unless the utility model is already resident.
           */
          vramTotalBytes: z.coerce.number().int().nonnegative().default(0),
          /** Headroom always left unallocated. Covers the compositor, HBPE's scratch, estimate error. */
          safetyMarginBytes: z.coerce
            .number()
            .int()
            .nonnegative()
            .default(1024 ** 3),
          /** Top rung of the utility model's context ladder (32K → 16K → 8K → 4K). */
          maxUtilityContextTokens: z.coerce.number().int().positive().default(32_768),
          /**
           * How many requests the Ollama server runs concurrently per loaded model
           * (`OLLAMA_NUM_PARALLEL` on the HOST — a server setting this process cannot
           * read back, so whoever provisions the host says it: CI-Hub via the app env,
           * or the operator via `LLM_OLLAMA_NUM_PARALLEL`). Every slot holds its own KV
           * cache, so the planners divide the card by this before sizing a window, and
           * the image-description queue admits this many jobs at once. `1` is always
           * safe: a wrong `1` only leaves a slot idle, a wrong `2` reloads at twice the
           * KV it can afford.
           */
          parallelSlots: z.coerce.number().int().min(1).max(8).default(1),
          /**
           * After the planner asks Ollama to load the utility model, how long
           * it may stay absent from `/api/ps` before the planner concludes the
           * load is stuck behind an eviction that cannot happen. A cold load of
           * a ~10 GB model finishes in 10–20 s; the first-response deadline is
           * 90 s. 0 disables the watchdog.
           */
          loadWatchdogMs: z.coerce.number().int().nonnegative().default(120_000),
          /**
           * How long co-residency stays off after the watchdog fires (or a
           * planned load times out). Utility calls run on the chat model
           * meanwhile. Long enough for the wedge to clear or be noticed.
           */
          cooldownMs: z.coerce
            .number()
            .int()
            .positive()
            .default(15 * 60_000),
        })
        .default({}),
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
    /**
     * Bearer the API presents on every request to the HBPE and Summary
     * sidecars (and the document parser), which refuse requests without it.
     * Minted by setup-secrets as SIDECAR_AUTH_SECRET. Required in production —
     * see the check below the schema — because an API without it cannot
     * dispatch a single function run.
     */
    sidecarAuthSecret: z.string().default(''),
  }),
  signalCli: z.object({
    restUrl: z.string(),
  }),
  // Embedding/indexing pipeline knobs. These let a deployment point the embedder
  // at another engine or host and tune throughput for bulk imports without code
  // changes. `apiBase` defaults to services.ollama.host (resolved below) so the
  // embedder follows the main Ollama host unless LLM_EMBEDDING_API_BASE pins it.
  embedding: z.object({
    /**
     * The embedding endpoint pinned for this process (LLM_EMBEDDING_API_BASE),
     * the sibling of LLM_API_BASE: an OpenAI-style base such as
     * `http://host:13305/api/v1`, or a bare host. Stored as the root — a trailing
     * `/v1` is dropped — because the embedder speaks the native `/api/embed`
     * there first and `/v1/embeddings` when that route is missing. Unset, the
     * embedder follows the chat backend when that serves it, else the Ollama
     * host — see EMBED_HOST_EXPLICITLY_CONFIGURED and
     * EmbeddingGenerationService.resolveTarget.
     */
    apiBase: z.string().optional(),
    /**
     * OLLAMA_EMBED_HOST, the name this setting had while embeddings were
     * Ollama-only. Read as a fallback for `apiBase`, with a warning, so an
     * older CI-Hub manifest or `.env` keeps working; remove once nothing sets it.
     */
    legacyHost: z.string().optional(),
    /** Embedding model name (must match the pgvector column dimensionality). */
    model: z.string().default('nomic-embed-text'),
    /** Max texts sent to Ollama's /api/embed in a single HTTP request. */
    batchSize: z.coerce.number().int().positive().default(32),
    /**
     * Longest text sent to the embedder, in characters; anything past it is
     * cut. Ollama's `/api/embed` truncated to the model's window itself (2048
     * tokens for nomic-embed-text as Ollama runs it), and the OpenAI dialect
     * has no such option — llama-server refuses an over-long input outright
     * (see `isInputTooLong`). 8,000 characters is about 2,000 tokens of prose,
     * the same bound the Summary sidecar applies (`text[:8000]`), and past
     * nomic's 2048-token training window the vectors get worse, not better.
     */
    maxInputChars: z.coerce.number().int().positive().default(8000),
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
    /**
     * Appliance-wide fallback execution deadline for ONE job, in seconds
     * (`CI_QUEUE_JOB_TIMEOUT_SECONDS`).
     *
     * Only a fallback: `PGBossEventService.jobDeadlineMs` prefers the queue's
     * own declared `expireInSeconds`, so the eleven queues that state a budget
     * keep theirs — `llm` 900 s, `agent-memory` 300 s, `ingest-coalesce` 1 h,
     * `py-fn-summary` 30 min, `agent` 2 h, `py-fn-hbpe` ~8 h, and the five
     * import queues at 12 h. This is what the other 28 get, and before it
     * existed they got nothing at all: a listener that neither resolved nor
     * rejected — a `fetch` with no timeout, an Ollama call that hung — held its
     * per-queue slot, its global semaphore slot and its fetch-side
     * `JobSlotPool` slot for the life of the process, with no log. Enough of
     * those and the queue silently stops, which is exactly how it presented in
     * production.
     *
     * 7200 (2 h) bounds the 28 queues whose unit of work is one entity, one
     * file, one bounded batch or one ~60 s pipeline slice — two orders of
     * magnitude of headroom over any of them, so it can only ever fire on
     * something wedged. It is emphatically NOT a number to size long work
     * against: this value replaced nothing, but it did TIGHTEN the effective
     * bound, because a queue declaring no `expireInSeconds` was already
     * inheriting the pg-boss constructor's `expireInHours: 12`. The import
     * lane, which legitimately runs for hours, therefore states 12 h of its own
     * rather than inheriting this — see `IMPORT_STAGE_EXPIRE_SECONDS`, and
     * `docs/jobs-system.md` §1.11 for the per-queue verdicts behind the 28.
     *
     * Any queue that can outrun two hours must say so the same way. Raising
     * THIS number instead is the wrong lever — it widens the wedge window for
     * all 28 to buy headroom for one. Lowering it is only honest after reading
     * a queue's p95 out of `ci.job_metrics`, and is likewise a per-queue edit.
     * `PGBossEventService.MIN_JOB_DEADLINE_MS` floors whatever lands here, so a
     * misconfigured 1 cannot kill every job on the appliance.
     */
    jobTimeoutSeconds: z.coerce.number().int().positive().default(7200),
    /**
     * Days a REPLAYED dead letter is kept in `ci.pipeline_dead_letters` before
     * `DeadLetterReaperListener.purgeReplayed` reclaims it.
     *
     * Scope, exactly: a row whose `replayed_at` is non-NULL — meaning an
     * operator asked for it back and `EventService.send` accepted the job (the
     * claim is released on every failure path, so the stamp is proof of a
     * successful re-emit, not of an attempt). An UNREPLAYED letter has no TTL
     * and is never touched by any sweep; that promise is the reason the table
     * exists, and no value here weakens it.
     *
     * 30 days matches `JobMetricsCollector`'s retention, which is the other
     * operational history on this appliance: long enough to answer "did we
     * already replay this, and when?" during and after an incident, short
     * enough that the replayed half of the table cannot grow without bound
     * behind a writer that can insert 360k rows a day.
     *
     * Raise it (CI_REPLAYED_DEAD_LETTER_RETENTION_DAYS=3650) to effectively
     * suspend the purge — during an incident when the replay audit trail is
     * still being read, or on a deployment that wants it kept forever. Positive
     * integer only: zero or negative would mean "delete letters replayed just
     * now", and the purge refuses such a window rather than obeying it.
     */
    replayedDeadLetterRetentionDays: z.coerce.number().int().positive().default(30),
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
      // Where `inboxDir` lives on the HOST, when the API runs in a container
      // and the inbox is a bind mount. The scan reports the folder a person
      // should drop files into, and `/var/lib/ci-import/inbox/<user>` is a
      // path inside the container that no desktop can reach — Hub, and the
      // production compose, bind it from somewhere on the appliance's own
      // disk, and THAT is the spelling to show. A label only: nothing on the
      // server resolves it, so it is not `path.resolve`d, not required to
      // exist, and not part of the nesting check below. Empty (the default,
      // and the right value for a bare-metal dev stack) shows `inboxDir`.
      inboxHostDir: z.string().default(''),
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
      // Where the DATABASE's volume is visible to THIS process, for the push's
      // free-space preflight. Empty by default and usually right that way:
      // `readDatabaseSpace` asks Postgres for its own `data_directory` first,
      // which resolves whenever the two share a filesystem namespace. Set this
      // when they do not — the shipped topology runs the api and the database
      // in separate containers — to the api-side mount of the same volume.
      // Unreadable or unset simply means the push reports "cannot say" and
      // relies on catching the disk-full error instead of predicting it.
      databaseDataDir: z.string().default(''),
      // How long staging survives its run. Two windows, because two different
      // things are stored here and only one of them is scratch.
      //
      // MEASURED, not guessed. On a dev appliance that imported one real
      // Google Takeout three times, `ci_import` held 1678 MB against ci.*'s
      // 1274 MB — staging was LARGER than the durable records it produced, and
      // 56% of a 3010 MB database. `staged_items` alone was 1578 MB over
      // 1.94M rows: 852 bytes per parsed record including indexes, so one
      // 780,946-item run costs ~640 MB forever. `import_runs` +
      // `import_stages` for the same 24 runs came to 240 kB — about 10 kB a
      // run, which is why the two are given very different windows.
      retention: z.object({
        enabled: booleanStringSchema.default(true),
        // The scratchpad window. Long enough to cover the deferred-push gap
        // the Sync card is built around (parse today, push when you get to
        // it) and any realistic re-push, and far longer than the longest
        // observed run wall-time (~1 day for a 780k-item Takeout). Nothing
        // resumable is ever taken regardless of this number — the sweep skips
        // any run still holding `pending` or `failed` staged rows — so this is
        // the disk dial, not the safety mechanism. 0 means "as soon as the run
        // is terminal and drained", which is a defensible setting on an
        // appliance short of disk.
        stagingDays: z.coerce.number().int().nonnegative().default(7),
        // The audit window. `import_runs` / `import_stages` are what the
        // import UI renders — the run list, the stage bar, `detail->>'pushed'`
        // for "3,412 records", and `declared_sources` for the picker's
        // "imported ✓". None of that reads a `staged_*` row, which is what
        // makes the split possible: history survives the payload it describes.
        // Deleting the run row cascades everything, so this is also the
        // backstop for a run whose payload the staging sweep declined to take.
        runHistoryDays: z.coerce.number().int().positive().default(90),
        // Sweep bounds. The cron is nightly and reclamation must never be the
        // reason the disk is busy, so a sweep takes a bounded number of runs
        // and deletes each run's rows in bounded batches rather than opening
        // one transaction over 780k rows.
        maxRunsPerSweep: z.coerce.number().int().positive().default(200),
        deleteBatchSize: z.coerce.number().int().positive().default(5000),
      }),
    })
    .superRefine((value, context) => {
      // History must outlive the payload it describes. Inverted, the run purge
      // would delete the audit trail while the scratchpad it points at was
      // still being kept — which is the opposite of what the split is for.
      if (value.retention.runHistoryDays < value.retention.stagingDays) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `import.retention.runHistoryDays (${value.retention.runHistoryDays}) must be >= ` +
            `import.retention.stagingDays (${value.retention.stagingDays}): run history is the audit ` +
            'trail for staging that has already been reclaimed, so it cannot expire first.',
        });
      }

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
  // In-app account deletion (App Store Guideline 5.1.1(v), Google Play Data
  // Deletion). `DELETE /account` revokes access immediately; the purge job
  // destroys the data afterwards. See docs/architecture/account-deletion.md.
  accountDeletion: z.object({
    /**
     * Days between "delete my account" and the irreversible purge — the window
     * in which a mistaken deletion can still be undone by an operator.
     *
     * Changing this only affects deletions requested *afterwards*: the deadline
     * is stamped onto the row at request time, precisely so editing a config
     * value cannot extend a promise already made to someone who has left.
     */
    graceDays: z.coerce.number().int().nonnegative().default(30),
    purge: z.object({
      /**
       * Off leaves `purge_after` unenforced — deletion revokes access and keeps
       * the data. Any deployment that tells its users their data is deleted must
       * leave this on; it exists so an operator mid-incident can stop an
       * irreversible job without editing code.
       */
      enabled: booleanStringSchema.default(true),
      /**
       * Rows per statement. Small enough that no single delete holds a lock long
       * enough to matter on an appliance, large enough that a million-row table
       * is thousands of statements rather than millions.
       */
      batchSize: z.coerce.number().int().positive().max(100_000).default(500),
      /** Accounts per run; a backlog is drained across ticks, not in one. */
      maxAccountsPerRun: z.coerce.number().int().positive().default(5),
      /** How long a failed account waits before the next attempt. */
      retryBackoffMinutes: z.coerce.number().int().positive().default(60),
      /**
       * `schema.table.column` entries to leave alone.
       *
       * The purge finds user-scoped columns by convention as well as by foreign
       * key, so a `uuid user_id` that does *not* mean "this row belongs to this
       * account" would be purged wrongly. Empty today; an entry here needs a
       * comment saying why the column is not account data.
       */
      excludedColumns: z.preprocess((val) => {
        if (typeof val === 'string') {
          return val
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
        }

        return val;
      }, z.array(z.string()).default([])),
    }),
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
  // The reflection loop — the appliance answering a personal question ON THE
  // USER'S BEHALF from their own imported data (see AnswerInferenceListener).
  // Everything it writes lands in ci.answers next to answers the user typed
  // themselves, so the only thing separating a well-evidenced inference from a
  // fabrication is the confidence the model reports and this floor.
  reflection: z
    .object({
      /**
       * Confidence below which NO answer is written at all — the question is
       * left unanswered rather than filled with a guess.
       *
       * 0.4 is the bottom of the "inferred from indirect or partial evidence"
       * band the model is scored against (see INFERRED_ANSWER_PROMPT_RULES);
       * anything under it the prompt itself calls a guess. Raise it on an
       * appliance whose owner wants only well-evidenced inferences; set it to 0
       * to write whatever comes back, which is the pre-confidence behaviour and
       * is not recommended — an unanswered question costs a blank card, a
       * fabricated one costs the user's trust in every other answer on the page.
       */
      minAnswerConfidence: z.coerce.number().min(0).max(1).default(0.4),
      /**
       * Confidence at/above which an inference writes to `ci.answers` (or
       * applies a graph/planning action) without a review step, per trust
       * mode (see `PersonalizationService.profileForTrustMode`). Below it the
       * action is held for review — see `PersonalizationService.decide`.
       *
       * Defaults match this repo's original hardcoded values. Set any of
       * these to 0 to auto-apply everything that clears `minAnswerConfidence`
       * above, which is useful for local testing but not recommended on a
       * real appliance for the same reason `minAnswerConfidence` warns against
       * 0: nothing then distinguishes a well-evidenced inference from a guess.
       */
      autoPromoteThresholdCautious: z.coerce.number().min(0).max(1).default(1),
      autoPromoteThresholdBalanced: z.coerce.number().min(0).max(1).default(0.55),
      autoPromoteThresholdHandsOff: z.coerce.number().min(0).max(1).default(0.7),
      /**
       * Below this, `PersonalizationService.decide` always returns 'review'
       * regardless of trust mode or action kind — the floor beneath every
       * `autoPromoteThreshold*` above.
       *
       * It has to move WITH `autoPromoteThresholdBalanced`, not independently:
       * `decide` tests this floor FIRST and returns 'review' before any
       * promote threshold is consulted, so a promote threshold set below this
       * floor is dead config. Lowering only one of the pair changes nothing.
       */
      alwaysReviewBelowConfidence: z.coerce.number().min(0).max(1).default(0.55),
    })
    .default({}),
  agent: z
    .object({
      // Retention for `ci.agent_memories` — the raw fragments the agent writes
      // through `POST /memory/write`, which `MemoryCompactionService` promotes
      // into the knowledge graph and `RecallService` re-reads verbatim as its
      // naive-RAG channel. See AgentMemoryRetentionService for why the two
      // lifecycle halves are given very different treatment.
      memoryRetention: z
        .object({
          /**
           * Off keeps every fragment forever, which is the behaviour that
           * shipped before this sweep existed. It exists so an operator can
           * stop an irreversible job without editing code, not because keeping
           * everything is a defensible steady state.
           */
          enabled: booleanStringSchema.default(true),
          /**
           * Days a PROCESSED fragment is kept after `processed_at` is stamped.
           *
           * The house convention (365) rather than something shorter, because
           * on this table the raw text is not dead weight after compaction:
           * `RecallService`'s message channel vector-searches these fragments
           * and unions their text in precisely because the graph
           * serialisation the compactor produces is lossy ("Priya Sharma —
           * lives in Phoenix" versus the sentence that also said she moved
           * from Eugene last spring). Shortening this trades recall detail for
           * disk, and the disk is not the constraint: a fragment is a few
           * hundred bytes of text plus one dense embedding, so even a chatty
           * producer costs low hundreds of MB a year.
           *
           * Shorten it on an appliance whose owner would rather the raw
           * conversational text not outlive its distillation — that is the
           * reason to move this number, not space.
           */
          processedDays: z.coerce.number().int().positive().default(365),
          /**
           * Age at which an UNPROCESSED fragment is reported as a stuck
           * pipeline. Never a deletion trigger: an unprocessed fragment is the
           * only copy of text nothing has promoted anywhere, so age alone can
           * never be grounds for destroying it. A week is long enough that a
           * paused compaction cron or an Ollama outage has visibly failed to
           * clear rather than merely fallen behind — the compactor takes 100
           * fragments every five minutes when it is healthy.
           */
          stuckAfterDays: z.coerce.number().int().positive().default(7),
          /** Days a raised stuck-pipeline card suppresses its own repeat. */
          stuckAlertRepeatDays: z.coerce.number().int().positive().default(7),
          /**
           * Fragments deleted per nightly sweep.
           *
           * Deliberately small. Each deletion goes through
           * `AgentMemoryService.remove`, which also emits the event that reaps
           * the fragment's `ci_search.embeddings` row — correctness the sweep
           * cannot get from a bulk `DELETE` — so this bounds a per-row path,
           * not one statement. A backlog drains across nights and is logged
           * while it lasts.
           */
          deleteBatchSize: z.coerce.number().int().positive().default(500),
        })
        .default({}),
    })
    .default({}),
  // The chat-turn memory producer. `ci.agent_memories` was written by exactly
  // one caller (POST /memory/write, ApiKeyGuard-only), so on an appliance whose
  // owner talks to their own web chat the table stayed empty and everything
  // downstream of it — compaction, the fragment embedding, the recall message
  // channel — had nothing to read. `TurnFragmentCron` is the missing producer.
  // Consumed by `domains/agent/cron/TurnFragmentCron.ts` and
  // `domains/agent/services/TurnFragmentService.ts`.
  agentMemory: z
    .object({
      turnFragments: z
        .object({
          /**
           * Minutes between fan-out ticks. Bounded 5..15 on purpose: below 5
           * the cron re-scans the same settling turns for no gain, above 15 a
           * fragment written now is not recallable for a quarter of an hour,
           * which is long enough that the next question in the same session
           * misses it.
           */
          intervalMinutes: z.coerce.number().int().min(5).max(15).default(10),
          /**
           * How far back a tick looks. Must comfortably exceed
           * `intervalMinutes` so a skipped tick (restart, a long-running
           * previous tick) still gets picked up by the next one.
           */
          lookbackMinutes: z.coerce
            .number()
            .int()
            .positive()
            .max(24 * 60)
            .default(120),
          /**
           * Turns younger than this are left alone. A tool-calling turn writes
           * several assistant rows against one prompt, and the fragment id is
           * keyed on the prompt (not the text) so the FIRST write wins — a
           * settle delay is what stops a half-finished chain becoming the
           * permanent fragment.
           */
          settleMinutes: z.coerce.number().int().nonnegative().default(3),
          /** Turns distilled per user per tick. Bounds one user's backlog. */
          maxTurnsPerUser: z.coerce.number().int().positive().default(25),
          /**
           * Below this many characters (prompt + reply, after `<think>` is
           * stripped) the turn is not worth a fragment — "hi"/"thanks" pairs
           * would otherwise dominate the recall channel.
           */
          minFragmentChars: z.coerce.number().int().nonnegative().default(40),
          /** Per-side cap. A 40k-token reply is not a memory fragment. */
          maxSideChars: z.coerce.number().int().positive().default(2000),
        })
        .default({}),
    })
    .default({}),
  // Derived media the appliance makes from what the owner stores. Today that is
  // the browser-playable H.264 rendition of every video whose own codec
  // browsers cannot be relied on to decode (HEVC from every phone since ~2023;
  // Chrome on Linux fails it outright). Consumed by
  // `domains/files/services/VideoPlaybackService`.
  media: z
    .object({
      videoPlayback: z
        .object({
          /**
           * Longest edge of the rendition, in pixels; the original is never
           * upscaled. `0` keeps the original's resolution. Measured 2026-09-22
           * on an 11 s 4K HDR phone clip: 1920 → 7.7 MB, native 4K → 34 MB
           * (about 4.5× the storage, ~26 Mbit/s to stream), and for SDR
           * sources about 2.5× the encode time. 1080p is what the drawer and
           * lightbox display at on anything but a 4K monitor full-screen;
           * the original stays the download at full resolution either way.
           * Changing this affects renditions made from then on — existing
           * ones are kept, not re-encoded.
           */
          maxEdge: z.coerce.number().int().min(0).default(1920),
        })
        .default({}),
    })
    .default({}),
  features: z.object({
    'scheduled.answer.inferencing': booleanStringSchema,
    /**
     * The three `SyncOrchestrator` crons — job creation, provider fetch and
     * transform. Off is the kill switch for all outbound provider polling,
     * including the jobs POST /connections/sync-now enqueues; queued work
     * resumes untouched when it is turned back on.
     */
    'scheduled.connection.sync': booleanStringSchema,
    'pinned.demo.models': booleanStringSchema,
    'enable.system.prompt': booleanStringSchema,
    'advanced.theme.tab': booleanStringSchema,
    'require.signup.codes': booleanStringSchema,
    /**
     * Gates the Today home route that gives summaries, insights and derived
     * actions a list surface again. Off by default while the surface lands.
     */
    'today.page': booleanStringSchema,
    'files.page': booleanStringSchema,
    /** The archive-import surface (/import): upload, run progress, the source catalogue and the guide. */
    'import.page': booleanStringSchema,
    /**
     * Wholesale gate for the Reflections browse page (`/memory/reflections`,
     * formerly `/memory/questions`) and the Forecast tooltip link into Brief.
     * `/insights` itself always redirects to `/brief`; this flag does not hide
     * Brief.
     */
    'insights.page': booleanStringSchema,
    /** Wholesale gate for the Chat page (/chat + nav entry points). */
    'chat.page': booleanStringSchema,
    /** Wholesale gate for the Jobs page (`/jobs` + rail entry). */
    'jobs.page': booleanStringSchema,
    /**
     * Backend gate for the planning domain: `ci.tasks` and the planning GraphQL
     * surface (`TaskResolver`, `node(id)` for tasks). Off returns empty reads
     * and refuses writes. See docs/architecture/planning-roadmap.md.
     */
    'planning.enabled': booleanStringSchema,
    /** Wholesale gate for the Plan page (/plan + nav entry points). */
    'planning.page': booleanStringSchema,
    /** Shows the "Nothing planned yet" empty state on the Plan page when there are no tasks. */
    'planning.emptyState': booleanStringSchema,
    /**
     * Wholesale gate for the Self surface (`/self/*` + the Power Rail user
     * tile): identity, life details, account, Stats and Reflections.
     *
     * Its own flag because the tile is the ONLY mount point for the account
     * menu — Settings, Theme and Log out. It used to ride `stats.page`, so
     * turning off a flag named for a statistics page removed every way to open
     * Settings or sign out.
     */
    'self.page': booleanStringSchema,
    /** Enables the memory stats page (now the Stats tab inside Self): timeline
     * totals plus entity breakdowns by data source and by tag. */
    'stats.page': booleanStringSchema,
    /** Wholesale gate for the Schedule surface (`/schedule` + nav entry point):
     * committed events, the HBPE rhythm layer, and proposed candidates. On by
     * default. */
    'schedule.page': booleanStringSchema,
    /**
     * Wholesale gate for the Forecast page (`/forecast` + rail entry). Off by
     * default. Calendar's HBPE rhythm layer is `schedule.page` and is independent.
     */
    'forecast.page': booleanStringSchema,
    /** The standalone all-tags browse page (`/tags`). Restored — on by default —
     * after #1512 removed it and left no way to see every tag in the system.
     * Chips open the explorer filtered by the tag (`/memory?tags=<label>`). */
    'tags.page': booleanStringSchema,
    hbpe: booleanStringSchema,
    /** Enables the memory compaction cron that promotes note fragments into graph entities. */
    'agent.memory.compaction': booleanStringSchema,
    /**
     * Enables `TurnFragmentCron`: the appliance's own chat turns become raw
     * `ci.agent_memories` fragments. OFF by default — turning it on starts
     * writing conversation text into the recall channel, and (with
     * `agent.memory.compaction` also on) into the knowledge graph.
     */
    'agent.memory.turnFragments': booleanStringSchema,
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
    /**
     * Interpersonal "ask" feature (epic #1712): questions directed at another
     * user's memory, gated by consent.
     *
     * ON by default now that the consent gate, disclosure filter, tier ceilings
     * and per-item redaction are all in place — the reason it shipped dark
     * ("while the surface is being built") no longer holds.
     *
     * Enabling this does NOT open federation: an inbound peer ask additionally
     * requires `peers.audience` to be configured, and the peer route refuses
     * every request until it is. What this flag turns on is the LOCAL ask
     * surface, where every ask still defaults to owner review.
     */
    ask: booleanStringSchema,
    /**
     * Lets context-prompt generation ask one number-grounded selector from
     * ci_derived.daily_metrics. Default on; the 14-day coverage floor refuses
     * "most days" copy for a cold series. Set ENABLE_GROUNDED_PROMPTS=false to disable.
     */
    'grounded.prompts': booleanStringSchema,
    /**
     * Lets the correlation / anomaly / suggestion engines enqueue ci.actions
     * (and therefore Brief/feed cards). Findings still persist when this is
     * off. Default on; Brief producer cap is 3 derived actions per local day.
     */
    'derivation.engines': booleanStringSchema,
    /**
     * After bulk `/v1` materialize, enqueue a delayed singleton that runs the
     * owed enrichment legs even if the client never calls finish. Default on —
     * the previous default (hope the client remembers) was the #51 hole.
     */
    'ingest.selfHeal': booleanStringSchema,
    /**
     * Master gate for the Solid Protocol facade (`/solid/*`): WebID profile
     * documents and, as later slices land, LDP resources and WAC. Off by
     * default — the surface stays dark (routes 404) until explicitly enabled.
     */
    'solid.protocol': booleanStringSchema,
    /**
     * Serve the GraphiQL IDE at `GET /graphiql`. The page is static HTML that
     * authenticates per request with a pasted API key (see docs/graphql-api.md),
     * so it cannot sit behind the auth guard — which is why it was served
     * unauthenticated in every environment, loading its scripts from unpkg.com.
     * Introspection is already off in production; this makes the IDE match.
     * On by default, off in `production.json`, and ENABLE_GRAPHQL_IDE=true turns
     * it back on for a deployment that wants it. The Settings link follows the
     * flag.
     */
    'graphql.ide': booleanStringSchema,
    /**
     * The dispatch gate: `ToolRegistry.executeTool` consults `resolveToolGate`
     * and parks a destructive/external/not-locally-permitted intent in
     * `ci.pending_actions` instead of running it, returning `TOOL_QUEUED`.
     *
     * ON by default since 2026-09-25 (it shipped dark while the queue had no
     * UI). With it on, a destructive intent, or an external one that is not
     * a plain read (every connected-MCP tool is labelled this way), from the
     * owner's own chat is queued as an approval card under the `balanced` and
     * `cautious` dials and runs unattended only under `hands_off`; an external
     * read (`messaging.listMessages`) asks only under `cautious`. See
     * `PendingActionService.trustForToolCall` for the mapping and for why the
     * dial is read directly rather than through the inference scorer.
     * `?tier=local` execute calls are queued rather than run.
     *
     * ENABLE_PENDING_ACTIONS=false is the kill switch, and off is
     * byte-identical to the pre-gate behaviour: `PendingActionService.evaluate`
     * pins the tier to `appliance` and skips the dial, so the owner's every
     * call executes. An installed app's destructive intent is queued
     * regardless of this flag (the `managed-app` rule in `resolveToolGate`).
     */
    'tools.pendingActions': booleanStringSchema,
  }),
  environment: z.object({
    'database.query.logging': booleanStringSchema,
  }),
  ciPortal: z.object({
    url: z.string().optional(),
    deviceId: z.string().optional(),
    apiKey: z.string().optional(),
  }),
  // Peer federation (CI-Server #1711 Phase 3). `directoryUrl` is CI-Portal's
  // peer-discovery API base (handle → Companion endpoint + issuer); empty
  // disables discovery, and with it any outbound ask. Inbound peer asks are
  // additionally gated by the `ask` feature flag.
  peers: z.object({
    directoryUrl: z.string().optional(),
    /** This box's own Companion endpoint, published to the directory. */
    memoryEndpoint: z.string().optional(),
    /** This box's Portal handle. */
    handle: z.string().optional(),
    /**
     * The audience value CI-Portal mints into tokens addressed to THIS box.
     * Required for the inbound peer surface: without it a token issued for any
     * first-party client would be accepted here, so a token minted for another
     * Companion could be replayed against this one.
     */
    audience: z.string().optional(),
    /** Bound on every outbound call to a peer or the directory. */
    timeoutMs: z.coerce.number().int().positive().default(10_000),
    /**
     * REQUIRE a valid RFC 9421 message signature on the inbound peer surface.
     *
     * Off by default, and deliberately a separate knob from having a key: a box
     * that starts signing must not immediately stop talking to peers that have
     * not yet upgraded. The rollout is (1) both sides configure a key and sign,
     * (2) both sides turn this on. Turning it on with peers that do not sign
     * refuses them -- which is the point, but it is the operator's call and not
     * a side effect of setting a key.
     */
    requireHttpSignature: z.coerce.boolean().default(false),
    /**
     * This box's Ed25519 signing key, as a PRIVATE JWK (JSON string or object).
     *
     * Absent means this box does not sign; outbound asks go unsigned and a peer
     * with `requireHttpSignature` on will refuse them. An unusable value
     * degrades to the same thing rather than failing startup -- see
     * `PeerSignatureService.signingKey`.
     *
     * Generate one with:
     *   node -e "const {generateKeyPairSync}=require('node:crypto');
     *     console.log(JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({format:'jwk'})))"
     */
    signingKeyJwk: z.string().optional(),
    /**
     * OPT-IN escape hatch: let peer egress dial CGNAT space (100.64.0.0/10).
     *
     * OFF by default, and off is byte-identical to the pre-existing behaviour —
     * `urlPolicy.ts`'s address table blocks the whole range exactly as before.
     * This exists because CGNAT is also where Tailscale (and similar
     * carrier-grade-NAT mesh overlays) live: two appliances an operator has
     * deliberately linked over their own private tailnet fall in the SAME
     * range a hostile directory entry would use to reach the box's own LAN,
     * so without this knob they can never federate at all. Confirmed live: a
     * real cross-machine `sendPeerAsk` over Tailscale refused with "Peer
     * endpoint not permitted" before this flag existed.
     *
     * Deliberately narrower than "any private network". RFC1918 space (10/8,
     * 172.16/12, 192.168/16) stays blocked regardless of this setting — that
     * is where an appliance's OWN infrastructure typically lives (its Docker
     * network, its Postgres, a cloud VPC's internal services), so folding it
     * into the same switch would trade a narrow, tested federation scenario
     * for a much larger SSRF surface against the box's own internals. A
     * deployment that genuinely needs RFC1918 peer egress should get its own
     * explicit flag, not inherit this one for convenience.
     *
     * Loopback (127.0.0.0/8), link-local (169.254.0.0/16, including cloud
     * metadata) and 0.0.0.0/8 are NEVER gated by this flag, at any setting:
     * those guard against dialing the box's OWN services, a different mistake
     * than "I run a private mesh", and no operator intent should reopen them.
     *
     * Changes only which addresses `checkEgressUrl` treats as in range to
     * try. The DNS-rebinding / redirect protections in `peerEgressFetch`
     * (connect-time address pinning, zero redirects followed) apply UNCHANGED
     * to the newly-permitted range — a CGNAT hostname that rebinds to a
     * blocked answer is still refused, flag or no flag.
     *
     * `booleanStringSchema`, not `z.coerce.boolean()` — the plain coercion
     * `requireHttpSignature` above uses treats ANY non-empty string as `true`,
     * including the literal string `"false"` an env var would carry, which is
     * exactly why that field still has no env mapping in
     * `custom-environment-variables.json`. This flag is meant to be operator
     * -set via `CI_PEER_ALLOW_CGNAT_ENDPOINTS`, so it needs the schema that
     * actually parses `"true"`/`"false"` strings correctly.
     */
    allowCgnatEndpoints: booleanStringSchema.default(false),
  }),
  /**
   * Where the abuse-control counters live -- the rate-limit windows and the
   * signature replay nonces (G8, #2365).
   *
   * `postgres` (the default) shares them across every api replica and survives
   * a restart. `memory` keeps them per-process, which is what shipped three
   * times and what G8 reports: N replicas means N times the effective limit,
   * and for the nonce cache it means a REPLAY SUCCEEDS ONCE PER REPLICA.
   *
   * Set `memory` only on a single-process box, or in a test that does not want
   * a database.
   */
  consumption: z.object({
    store: z.enum(['postgres', 'memory']).default('postgres'),
  }),
  // Geocoding, both directions (address <-> coordinates). Egress normally goes
  // through CI-Portal, which holds the provider key and fronts a cache shared by
  // every appliance; `google` is the direct-key fallback and is the only mode
  // that reads `apiKey` (GEOCODING_API_KEY, falling back to the legacy
  // GOOGLE_MAPS_KEY — see custom-environment-variables.json + the transform below).
  /**
   * Link previews ("unfurls") — what `enrich.unfurl` may fetch on the user's
   * behalf. Every call is a server-side request to a host the content chose,
   * through the SSRF chokepoint in domains/embed/services/UnfurlFetcher.ts.
   */
  unfurl: z.object({
    /** Master switch; off records every candidate as skipped: disabled. */
    enabled: z.coerce.boolean().default(true),
    /** Per-host request ceiling. Provider oEmbed endpoints and Wikimedia's APIs are generous at this rate. */
    ratePerSecond: z.coerce.number().positive().default(2),
    /**
     * Follow arbitrary http(s) content URLs for OpenGraph metadata. Provider
     * oEmbed and Wikimedia are fixed hosts; this one is the long tail and the only
     * setting that makes the appliance fetch a page it has never heard of.
     */
    openGraph: z.coerce.boolean().default(true),
    /** Copy posters into object storage so a dead provider link does not blank the tile. */
    cachePosters: z.coerce.boolean().default(true),
  }),
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
  // Web Push (VAPID) for planning reminders — see docs/architecture/planning-roadmap.md
  // M5 and WebPushService. Deliberately config-only, not a stored/generated
  // keypair: the roadmap's "Deliberately not doing" table rules out a generic
  // `app_config` table, and unlike CI-Planning's SQLite server (which
  // generates and PERSISTS a keypair on first boot because it has nowhere
  // else to put one), this appliance already has the operator-provisioned
  // secret convention every other cryptographic key here follows —
  // AUTH_TOKEN_SECRET, AUTH_FIELD_ENCRYPTION_KEY, AUTH_CSRF_TOKEN_SECRET — so
  // VAPID keys follow it too rather than inventing a new persistence
  // mechanism for one feature. Both empty (the default) means push is simply
  // OFF: `WebPushService.isConfigured()` returns false, reminders still fire
  // (the record still moves to 'fired'), and the resolver's `pushPublicKey`
  // query returns null so the client never shows a "turn on push" control.
  //
  // Generate a pair with `npx web-push generate-vapid-keys` and set both
  // VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — a HALF-set pair is refused the same
  // way an operator-supplied env keypair is refused elsewhere in this file
  // (see the field-encryption warning above): `WebPushService` treats
  // "exactly one of the two set" as a misconfiguration and leaves push
  // dormant rather than guessing. Never rotate an existing pair without
  // clearing `ci.push_subscriptions` first — a subscription is
  // cryptographically bound to the public key it was created against, so
  // rotating breaks push for every existing subscriber at once.
  push: z.object({
    vapid: z.object({
      publicKey: z.string().default(''),
      privateKey: z.string().default(''),
      /** `mailto:` contact a push service may use if it needs to reach the sender. Cosmetic. */
      subject: z.string().default('mailto:admin@companion.local'),
    }),
  }),
});

const parsed = ConfigSchema.parse(config);

/**
 * Point an inference URL at the right side of the container boundary.
 *
 * The same `.env` is read by this process on the host (`make dev` runs api and
 * worker under overmind) and by this process in a container (staging and
 * production compose), and by the two python sidecars, which are always
 * containers. `localhost` names the container itself from inside one, and
 * `host.docker.internal` resolves nowhere on a macOS or linux host, so no single
 * spelling is correct for every reader — and because compose interpolates
 * `${LLM_API_BASE:-<good default>}`, a set-but-wrong value in `.env` beats the
 * correct default the repo ships. Correcting it here, once, means every consumer
 * downstream (LlmEndpointService, OllamaService, the OpenAI driver, the embedder)
 * gets a URL that works from where it is, and none of them has to know why.
 *
 * Never silent: a rewrite prints, because moving where inference goes without
 * saying so is how the original bug stayed invisible for a full nightly run.
 */
function llmUrlForThisRuntime(label: string, value: string): string;
function llmUrlForThisRuntime(label: string, value: string | undefined): string | undefined;
function llmUrlForThisRuntime(label: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const { url, note } = resolveLlmUrlForRuntime(value);

  if (note) {
    console.warn(`[config] ${label}: ${note}`);
  }

  return url;
}

parsed.services.ollama.host = llmUrlForThisRuntime('OLLAMA_HOST', parsed.services.ollama.host);
parsed.llm.apiBase = llmUrlForThisRuntime('LLM_API_BASE', parsed.llm.apiBase);

// Captured BEFORE the default below fills it in: whether an operator (or the
// Hub installer) pinned the embedding endpoint — LLM_EMBEDDING_API_BASE, or its
// old name OLLAMA_EMBED_HOST — as distinct from the embedder following the chat
// backend or the Ollama host. `EmbeddingGenerationService` embeds where it is
// told when this is true, and otherwise on the chat backend when that backend
// serves the embedder (see `resolveTarget` there). Same `config.has` reasoning
// as UTILITY_MODEL_EXPLICITLY_CONFIGURED below: default.json carries neither
// key, so only the env mapping can put one there.
export const EMBED_HOST_EXPLICITLY_CONFIGURED =
  (config.has('embedding.apiBase') && Boolean(config.get('embedding.apiBase'))) ||
  (config.has('embedding.legacyHost') && Boolean(config.get('embedding.legacyHost')));

if (!parsed.embedding.apiBase?.trim() && parsed.embedding.legacyHost?.trim()) {
  console.warn(
    '[config] OLLAMA_EMBED_HOST is deprecated; set LLM_EMBEDDING_API_BASE instead (same value, ' +
      'any engine). Using it for this process.',
  );
  parsed.embedding.apiBase = parsed.embedding.legacyHost;
}

// Stored as the root the native `/api/embed` lives under: `.../v1` and
// `.../api/v1` (Lemonade) both mean "this server", and the embedder adds the
// route it needs. Corrected for this runtime first, like the chat base, so an
// inherited value arrives already right.
parsed.embedding.apiBase = llmUrlForThisRuntime(
  'LLM_EMBEDDING_API_BASE',
  parsed.embedding.apiBase?.trim() || undefined,
)?.replace(/\/+$/, '');
if (parsed.embedding.apiBase?.endsWith('/v1')) {
  parsed.embedding.apiBase = parsed.embedding.apiBase.slice(0, -'/v1'.length);
}

// The embedder follows the main Ollama host unless an embedding endpoint is
// pinned, so a GPU/alternate-host engine can be pointed at for embeddings only
// without touching the chat endpoint.
if (!parsed.embedding.apiBase) {
  parsed.embedding.apiBase = parsed.services.ollama.host;
}

// CI-Hub names the embedder it installed in LLM_DEFAULT_EMBEDDING_MODEL (its `embedding_model` handout,
// which the Summary sidecar already reads). This process used to read only CI_EMBED_MODEL, so it asked
// Hub's endpoint for `nomic-embed-text` whatever Hub had installed: fine beside Ollama, a failed embed
// on every row on a Lemonade-only node, whose embedder is `nomic-embed-text-v1.5-GGUF` (the same
// weights; see embedModelIdentity.ts). An operator's CI_EMBED_MODEL still wins, and is still held to
// the declared generations at boot. A handed-out name with no declared generation is refused here
// with an error line instead of failing boot: an older Hub hands out Lemonade's v1
// (`nomic-embed-text-v1-GGUF`), a different vector space from every existing index, and embedding
// with it would scramble search rather than fix it.
if (!process.env.CI_EMBED_MODEL?.trim()) {
  const handedOut = process.env.LLM_DEFAULT_EMBEDDING_MODEL?.trim();

  if (handedOut && handedOut !== parsed.embedding.model) {
    if (isDeclaredEmbedModel(handedOut)) {
      parsed.embedding.model = handedOut;
    } else {
      console.error(
        `[config] LLM_DEFAULT_EMBEDDING_MODEL=${handedOut} has no declared embedding generation ` +
          `(EMBED_MODEL_GENERATIONS in common/embeddings/embedModelIdentity.ts); embedding with ` +
          `${parsed.embedding.model} instead. Update CI-Hub, or set CI_EMBED_MODEL deliberately.`,
      );
    }
  }
}

if (!parsed.llm.apiBase) {
  parsed.llm.apiBase = undefined;
}

if (!parsed.llm.apiKey) {
  parsed.llm.apiKey = 'ollama';
}

if (!parsed.llm.chatModel) {
  parsed.llm.chatModel = DEFAULT_CHAT_MODEL;
}

// Captured BEFORE the default below overwrites it: whether an operator (or
// the Hub installer) actually set LLM_UTILITY_MODEL, as distinct from it
// having fallen back to the compiled-in DEFAULT_UTILITY_MODEL. `config.has`
// reads the raw merged sources (env + config/*.json) ahead of this file's own
// normalization, so it sees "absent" exactly when the env var was never set —
// default.json carries no `llm.utilityModel` key at all, only
// custom-environment-variables.json's LLM_UTILITY_MODEL mapping can put one
// there. Exists so a vision-capable utility model is only ever used for
// vision work when an operator asked for it: see UTILITY_MODEL_EXPLICITLY_CONFIGURED
// in OllamaService, which is what actually reads this.
export const UTILITY_MODEL_EXPLICITLY_CONFIGURED =
  config.has('llm.utilityModel') && Boolean(config.get('llm.utilityModel'));

// An empty LLM_UTILITY_MODEL means "not configured", not "use the empty
// string" — same normalization chatModel gets just above. Falling back to the
// small compiled-in default rather than to `chatModel` is deliberate: inheriting
// the operator's chat model is exactly the coupling this setting exists to break.
if (!parsed.llm.utilityModel) {
  parsed.llm.utilityModel = DEFAULT_UTILITY_MODEL;
}

// GEOCODING_API_KEY takes precedence; fall back to the legacy GOOGLE_MAPS_KEY so
// existing deployments keep working until the billed key is supplied. (config's
// custom-environment-variables.json maps one env var per field, not a fallback
// chain — so the OR lives here.)
if (!parsed.geocoding.apiKey && process.env.GOOGLE_MAPS_KEY) {
  parsed.geocoding.apiKey = process.env.GOOGLE_MAPS_KEY;
}

/**
 * The geocoding proxy follows the Portal URL the box already uses unless an
 * explicit base URL is configured (GEOCODING_PORTAL_BASE_URL), so routing
 * geocoding via the hub host instead of Portal directly is a one-variable
 * change. Exported as a pure function (rather than inlined as an `if`) so the
 * fallback is unit-testable without re-parsing the whole config module under
 * different env vars.
 */
export function resolveGeocodingPortalBaseUrl(configured: string, ciPortalUrl: string | undefined): string {
  return configured || ciPortalUrl || '';
}

parsed.geocoding.portalBaseUrl = resolveGeocodingPortalBaseUrl(
  parsed.geocoding.portalBaseUrl,
  parsed.ciPortal.url,
);

/**
 * Whether the SELECTED geocoding provider actually has what it needs to make a
 * request, mirroring exactly what each provider's own postBatch/geocode check
 * already gates on (PortalGeocodeProvider's `!this.baseUrl || !this.deviceKey`,
 * GoogleGeocodeProvider's `!this.apiKey`) — kept as ONE function, here rather
 * than in the geocode domain, so a domain that cannot depend on geocode (the
 * geocode domain itself depends on MemoryModule, so PlaceService importing
 * back from geocode would be circular) can still ask the same question a
 * boot-time warning and a GraphQL status query also ask, and none of the three
 * can quietly disagree about what "configured" means.
 *
 * Portal is the default provider, so a bare `GEOCODING_PORTAL_BASE_URL` with no
 * `HUB_API_KEY` reads as unconfigured — before this, that exact combination
 * produced zero warnings anywhere, so ENRICH_GEOCODE silently never ran and
 * every place downstream showed "0 visits" indistinguishable from a genuinely
 * quiet place.
 */
export function isGeocodingConfigured(
  cfg: {
    geocoding: { provider: string; apiKey?: string; portalBaseUrl?: string };
    ciPortal: { apiKey?: string };
  } = parsed,
): boolean {
  return cfg.geocoding.provider === 'google'
    ? Boolean(cfg.geocoding.apiKey)
    : Boolean(cfg.geocoding.portalBaseUrl) && Boolean(cfg.ciPortal.apiKey);
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

// A base URL with no device key is just as unconfigured as no base URL at
// all (PortalGeocodeProvider.postBatch gates on both), but only the missing
// URL used to warn here — a box with GEOCODING_PORTAL_BASE_URL set and no
// HUB_API_KEY produced zero warnings anywhere except a private, latched,
// log-only line inside PortalGeocodeProvider itself.
if (parsed.geocoding.provider === 'portal' && parsed.geocoding.portalBaseUrl && !parsed.ciPortal.apiKey) {
  console.warn(
    '[configuration] geocoding.provider is "portal" but no device key is configured ' +
      '(HUB_API_KEY). Geocode backfills will report a transient failure until one is set.',
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

// The sidecars refuse every request without this bearer, so an API that lacks it
// is one whose imports never summarise and whose forecasts never train — and a
// sidecar it could still reach would be one anyone could reach. Refuse to boot
// outside dev rather than run half an appliance.
if (!parsed.services.sidecarAuthSecret) {
  const msg =
    '[configuration] SIDECAR_AUTH_SECRET is not set — the HBPE/Summary sidecars refuse requests ' +
    'without it. setup-secrets mints it; on an existing appliance it is added on the next boot.';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(msg);
  }

  console.warn(msg);
}

// Loud by design (see the field's own doc comment above): an operator who set
// CI_PEER_ALLOW_CGNAT_ENDPOINTS should never have to wonder later whether they
// did. This fires once, at boot, independent of whether the box ever actually
// makes a peer call into that range.
if (parsed.peers.allowCgnatEndpoints) {
  console.warn(
    '[configuration] CI_PEER_ALLOW_CGNAT_ENDPOINTS is set — peer egress may now dial addresses in ' +
      '100.64.0.0/10 (CGNAT space, including Tailscale). This box will treat that range as reachable ' +
      'peer infrastructure. Only enable this if you have deliberately linked your appliances over a ' +
      'private network you trust; RFC1918, loopback and link-local space remain blocked regardless.',
  );
}

export default parsed;
