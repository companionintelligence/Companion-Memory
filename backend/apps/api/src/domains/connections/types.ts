import { z } from 'zod';

export interface CompleteConnectionDto {
  state: string;
  code: string;
}

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
}

export interface connectProviderDto {
  apiKey?: string;
  endpoints: string[];
}

export const connectProviderSchema = z.object({
  endpoints: z.array(z.string()),
  apiKey: z.string().optional(),
});
