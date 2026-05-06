import { z } from 'zod';

const nonEmpty = z.string().min(1);

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  OPSSAGE_WEBHOOK_SECRET: nonEmpty,

  // flue uses `provider/model` as a single namespace string. We keep PROVIDER
  // separate because routing Anthropic-shaped traffic to Cursor's compatible
  // endpoint is a base-URL swap, not a different namespace.
  PROVIDER: z.enum(['anthropic', 'cursor']).default('anthropic'),
  FLUE_MODEL: z.string().default('anthropic/claude-sonnet-4-6'),
  FLUE_SANDBOX: z.enum(['local']).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CURSOR_API_KEY: z.string().optional(),
  CURSOR_BASE_URL: z.string().url().default('https://api.cursor.sh/v1'),

  DATADOG_API_KEY: nonEmpty,
  DATADOG_APP_KEY: nonEmpty,
  DATADOG_SITE: z.string().default('datadoghq.com'),

  GITHUB_TOKEN: nonEmpty,

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().default('https://cloud.langfuse.com'),

  OPSSAGE_REPOS_FILE: z.string().default('apps/agent/config/repos.yaml'),
  OPSSAGE_ALERT_CHANNEL: z.string().default('#alerts'),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors;
    const summary = Object.entries(flat)
      .map(([k, v]) => `  ${k}: ${(v ?? []).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${summary}`);
  }
  return parsed.data;
}
