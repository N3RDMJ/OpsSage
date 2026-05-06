import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchJson } from '@opssage/tools';

export interface SandboxClient {
  clone(input: { sessionId: string; repo: string; branch: string }): Promise<{ workdir: string }>;
  grep(input: {
    sessionId: string;
    pattern: string;
    path?: string;
    maxResults?: number;
  }): Promise<{ matches: GrepMatch[] }>;
  ls(input: { sessionId: string; path?: string }): Promise<{ entries: string[] }>;
  cleanup(input: { sessionId: string }): Promise<void>;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export function buildSandboxClient(opts: {
  mode: 'rpc' | 'in-process';
  url: string;
  githubToken: string;
}): SandboxClient {
  if (opts.mode === 'rpc') return new RpcSandboxClient(opts.url);
  return new InProcessSandboxClient(opts.githubToken);
}

class RpcSandboxClient implements SandboxClient {
  constructor(private readonly base: string) {}

  clone(input: { sessionId: string; repo: string; branch: string }) {
    return this.call<{ workdir: string }>('clone', input);
  }
  grep(input: { sessionId: string; pattern: string; path?: string; maxResults?: number }) {
    return this.call<{ matches: GrepMatch[] }>('grep', input);
  }
  ls(input: { sessionId: string; path?: string }) {
    return this.call<{ entries: string[] }>('ls', input);
  }
  cleanup(input: { sessionId: string }) {
    return this.call<void>('cleanup', input);
  }

  private call<T>(method: string, body: unknown): Promise<T> {
    return fetchJson<T>(`${this.base}/rpc/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    });
  }
}

/**
 * Local-mode sandbox: shells out to `git` + node fs APIs in a tempdir.
 * Used when SANDBOX_MODE=in-process so the agent can run end-to-end with no
 * Docker/ECS dependency.
 */
class InProcessSandboxClient implements SandboxClient {
  private readonly workspaces = new Map<string, string>();
  constructor(private readonly githubToken: string) {}

  async clone({ sessionId, repo, branch }: { sessionId: string; repo: string; branch: string }) {
    const dir = await mkdtemp(join(tmpdir(), `opssage-${sessionId}-`));
    this.workspaces.set(sessionId, dir);
    const url = `https://x-access-token:${this.githubToken}@github.com/${repo}.git`;
    await runGit(['clone', '--depth', '1', '--branch', branch, url, dir]);
    return { workdir: dir };
  }

  async grep({
    sessionId,
    pattern,
    path,
    maxResults = 50,
  }: {
    sessionId: string;
    pattern: string;
    path?: string;
    maxResults?: number;
  }) {
    const dir = this.workspaces.get(sessionId);
    if (!dir) throw new Error(`no workspace for session ${sessionId}; call clone() first`);
    const target = path ? join(dir, path) : dir;
    const matches: GrepMatch[] = [];
    const re = new RegExp(pattern);
    await walk(target, async (file) => {
      if (matches.length >= maxResults) return;
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) return;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        const line = lines[i] ?? '';
        if (re.test(line)) {
          matches.push({ path: file.slice(dir.length + 1), line: i + 1, text: line });
        }
      }
    });
    return { matches };
  }

  async ls({ sessionId, path }: { sessionId: string; path?: string }) {
    const dir = this.workspaces.get(sessionId);
    if (!dir) throw new Error(`no workspace for session ${sessionId}`);
    const target = path ? join(dir, path) : dir;
    const entries = await readdir(target);
    return { entries };
  }

  async cleanup({ sessionId }: { sessionId: string }) {
    const dir = this.workspaces.get(sessionId);
    if (!dir) return;
    await rm(dir, { recursive: true, force: true });
    this.workspaces.delete(sessionId);
  }
}

async function walk(root: string, fn: (file: string) => Promise<void>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = join(root, name);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) {
      await walk(full, fn);
    } else if (s.isFile()) {
      await fn(full);
    }
  }
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolveFn, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolveFn();
      else reject(new Error(`git ${args[0]} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

