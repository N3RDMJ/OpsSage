import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { type Env, loadRepoAllowlist, parseEnv, type RepoAllowlist } from '@opssage/config-schema';

export interface AppConfig {
  env: Env;
  repos: RepoAllowlist;
}

export async function loadConfig(): Promise<AppConfig> {
  if (process.env.NODE_ENV !== 'production') {
    loadDotenv({ path: resolve(process.cwd(), '.env.local') });
    loadDotenv({ path: resolve(process.cwd(), '.env') });
  }
  const env = parseEnv(process.env);
  const repos = await loadRepoAllowlist(resolve(process.cwd(), env.OPSSAGE_REPOS_FILE));
  return { env, repos };
}
