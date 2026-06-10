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
});

export default ConfigSchema.parse(config);
