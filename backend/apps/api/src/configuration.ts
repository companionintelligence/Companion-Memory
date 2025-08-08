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
      saltRounds: z.number(),
      fieldPepper: z.string(),
      duration: z.string(),
    }),
    providers: z.object({
      google: z.object({
        id: z.string(),
      }),
      microsoft: z.object({
        id: z.string(),
      }),
    }),
    oauth: z.object({
      callbackUrl: z.string(),
    }),
  }),
  db: z.object({
    type: z.literal('postgres'), // restrict to 'postgres' (or z.string() for other DBs)
    host: z.string(),
    port: z.number(),
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
  features: z.object({
    'scheduled.answer.inferencing': booleanStringSchema,
    'scheduled.connection.fetching': booleanStringSchema,
  }),
  environment: z.object({
    'database.query.logging': booleanStringSchema,
  }),
});

export default ConfigSchema.parse(config);
