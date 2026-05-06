import { z } from 'zod';

const nonEmpty = z.string().min(1);

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  OPSSAGE_WEBHOOK_SECRET: nonEmpty,

  // flue uses a single `provider/model` namespace string and resolves
  // credentials via env (see pi-ai's env-api-keys: ANTHROPIC_API_KEY).
  // Cursor support requires a custom pi-ai Model with a baseUrl override —
  // queued as a follow-up; not in v1.
  FLUE_MODEL: z.string().default('anthropic/claude-sonnet-4-6'),
  ANTHROPIC_API_KEY: z.string().optional(),

  DATADOG_API_KEY: nonEmpty,
  DATADOG_APP_KEY: nonEmpty,
  DATADOG_SITE: z.string().default('datadoghq.com'),

  GITHUB_TOKEN: nonEmpty,

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().default('https://cloud.langfuse.com'),

  // Resolved against process.cwd(). The agent's working directory in dev
  // (`flue dev` from apps/agent) and prod (Docker WORKDIR=/app) both put
  // the file at `config/repos.yaml`.
  OPSSAGE_REPOS_FILE: z.string().default('config/repos.yaml'),
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
