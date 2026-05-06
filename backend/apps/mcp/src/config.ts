import { z } from 'zod';

const envSchema = z.object({
  CI_API_BASE_URL: z.string().url().default('http://api:3030'),
  CI_API_SERVICE_KEY: z.string().min(1),
  CI_MCP_AUTH_TOKEN: z.string().min(1),
  CI_MCP_PORT: z.coerce.number().int().positive().default(3091),
  CI_OWNER_USER_ID: z.string().trim().min(1),
});

export type McpConfig = z.infer<typeof envSchema>;

export function readMcpConfig(): McpConfig {
  return envSchema.parse(process.env);
}
