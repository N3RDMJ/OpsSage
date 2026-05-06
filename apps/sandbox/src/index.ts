import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';

const ROOT = process.env.SANDBOX_WORK_DIR ?? '/work';
const PORT = Number.parseInt(process.env.PORT ?? '8081', 10);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const SHARED_SECRET = process.env.SANDBOX_SHARED_SECRET ?? '';

const sessionId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);

const cloneSchema = z.object({
  sessionId,
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  branch: z.string().min(1).max(200),
});

const grepSchema = z.object({
  sessionId,
  pattern: z.string().min(1).max(500),
  path: z.string().optional(),
  maxResults: z.number().int().positive().max(500).default(50),
});

const lsSchema = z.object({ sessionId, path: z.string().optional() });
const cleanupSchema = z.object({ sessionId });

const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true }));

app.use('/rpc/*', async (c, next) => {
  if (!SHARED_SECRET) return next();
  if (c.req.header('X-Sandbox-Secret') !== SHARED_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

app.post('/rpc/clone', async (c) => {
  const body = cloneSchema.parse(await c.req.json());
  const dir = sessionDir(body.sessionId);
  await mkdir(dir, { recursive: true });
  const url = GITHUB_TOKEN
    ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${body.repo}.git`
    : `https://github.com/${body.repo}.git`;
  await runCmd('git', ['clone', '--depth', '1', '--branch', body.branch, url, dir]);
  return c.json({ workdir: dir });
});

app.post('/rpc/grep', async (c) => {
  const body = grepSchema.parse(await c.req.json());
  const dir = sessionDir(body.sessionId);
  const target = body.path ? resolveInside(dir, body.path) : dir;
  const args = [
    '--no-messages',
    '--line-number',
    '--max-count',
    String(body.maxResults),
    '--regexp',
    body.pattern,
    target,
  ];
  const out = await runCmd('rg', args, { allowExitCodes: [0, 1] });
  const matches = out.stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, body.maxResults)
    .map((line) => parseRgLine(line, dir));
  return c.json({ matches });
});

app.post('/rpc/ls', async (c) => {
  const body = lsSchema.parse(await c.req.json());
  const dir = sessionDir(body.sessionId);
  const target = body.path ? resolveInside(dir, body.path) : dir;
  const out = await runCmd('ls', ['-1', target]);
  return c.json({ entries: out.stdout.split('\n').filter(Boolean) });
});

app.post('/rpc/cleanup', async (c) => {
  const body = cleanupSchema.parse(await c.req.json());
  await rm(sessionDir(body.sessionId), { recursive: true, force: true });
  return c.json({ ok: true });
});

app.onError((err, c) => {
  console.error(JSON.stringify({ level: 'error', err: String(err) }));
  return c.json({ error: String(err) }, 500);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(JSON.stringify({ level: 'info', msg: 'sandbox listening', port: info.port }));
});

function sessionDir(id: string): string {
  return join(ROOT, id);
}

function resolveInside(root: string, sub: string): string {
  const rooted = resolve(root, sub);
  const norm = normalize(rooted);
  if (!norm.startsWith(root + sep) && norm !== root) {
    throw new Error('path escapes session workspace');
  }
  return norm;
}

function parseRgLine(raw: string, root: string): { path: string; line: number; text: string } {
  // ripgrep default output: <path>:<line>:<text>
  const first = raw.indexOf(':');
  const second = raw.indexOf(':', first + 1);
  if (first < 0 || second < 0) return { path: raw, line: 0, text: '' };
  const path = raw.slice(0, first);
  const line = Number.parseInt(raw.slice(first + 1, second), 10);
  return {
    path: path.startsWith(root) ? path.slice(root.length + 1) : path,
    line: Number.isFinite(line) ? line : 0,
    text: raw.slice(second + 1),
  };
}

interface CmdResult {
  stdout: string;
  stderr: string;
}

function runCmd(
  cmd: string,
  args: string[],
  opts: { allowExitCodes?: number[] } = {},
): Promise<CmdResult> {
  return new Promise((resolveFn, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      const allow = opts.allowExitCodes ?? [0];
      if (code !== null && allow.includes(code)) {
        resolveFn({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} ${args[0]} exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}
