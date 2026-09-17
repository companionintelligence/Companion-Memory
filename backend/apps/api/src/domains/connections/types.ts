import { z } from 'zod';

/** Body of `POST /connections/complete`; `CompleteConnectionDto` is inferred from it, so the two cannot drift. */
export const completeConnectionSchema = z.discriminatedUnion('flow', [
  z.object({
    flow: z.literal('proxy'),
    state: z.string(),
    // Optional: with a refresh token the access token is fetched from CI Portal, not
    // taken from the browser (see `ConnectionsController.proxyTokens`). A body with
    // neither is refused by `ConnectionsController.completeCallback`.
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    expiresIn: z.number().int().positive().optional(),
    userProviderId: z.string(),
  }),
  z.object({
    flow: z.literal('direct'),
    state: z.string(),
    code: z.string(),
  }),
]);

export type CompleteConnectionDto = z.infer<typeof completeConnectionSchema>;

export interface CreateConnectionDto {
  name?: string;
  providerId: string;
  clientid?: string;
  accessToken?: string;
  clientkey?: string;
  clientsecret?: string;
  schedule?: string;
  endpoints?: string[];
  externalId?: string;
}

export interface UpdateConnectionDto {
  name?: string;
  active?: boolean;
  schedule?: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiry?: Date | null;
  syncState?: Record<string, unknown> | null;
  endpoints?: string[];
  needsReauth?: boolean;
  externalId?: string;
  accountLabel?: string | null;
}

export interface connectProviderDto {
  apiKey?: string;
  endpoints: string[];
}

export const connectProviderSchema = z.object({
  endpoints: z.array(z.string()),
  apiKey: z.string().optional(),
});
