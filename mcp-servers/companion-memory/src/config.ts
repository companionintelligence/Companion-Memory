import { z } from 'zod';

const EnvSchema = z.object({
  COMPANION_MEMORY_URL: z.string().url().default('http://localhost:3030'),
  COMPANION_MEMORY_API_KEY: z.string().min(1, 'COMPANION_MEMORY_API_KEY is required'),
  COMPANION_MEMORY_TIMEOUT_MS: z
    .preprocess((value) => (value === undefined ? undefined : Number(value)), z.number().int().positive())
    .default(15000),
  COMPANION_MEMORY_NAMESPACE: z.string().min(1).optional(),
  COMPANION_MEMORY_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type CompanionMemoryConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CompanionMemoryConfig {
  const result = EnvSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `- ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid companion-memory configuration:\n${issues}`);
  }

  return result.data;
}
