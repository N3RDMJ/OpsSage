import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const repoEntrySchema = z.object({
  service: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/name"'),
  primary_branch: z.string().default('main'),
  hot_paths: z.array(z.string()).default([]),
});

export type RepoEntry = z.infer<typeof repoEntrySchema>;

export const repoAllowlistSchema = z.array(repoEntrySchema);

export type RepoAllowlist = z.infer<typeof repoAllowlistSchema>;

export async function loadRepoAllowlist(path: string): Promise<RepoAllowlist> {
  const raw = await readFile(path, 'utf8');
  const parsed = parseYaml(raw);
  return repoAllowlistSchema.parse(parsed ?? []);
}

export function findRepoForService(
  allowlist: RepoAllowlist,
  service: string,
): RepoEntry | undefined {
  return allowlist.find((e) => e.service === service);
}
