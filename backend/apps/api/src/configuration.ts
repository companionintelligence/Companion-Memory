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
      callbackUrl: z.string(),
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
    hbpe: booleanStringSchema,
    /** Enables the memory compaction cron that promotes note fragments into graph entities. */
    'agent.memory.compaction': booleanStringSchema,
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

export default parsed;
