import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export interface Skill {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** Absolute path the skill was loaded from. */
  path: string;
}

const SKILLS_DIR_FROM_DIST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
);

export async function loadSkills(dir: string = SKILLS_DIR_FROM_DIST): Promise<Skill[]> {
  const entries = await readdir(dir);
  const out: Skill[] = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const path = join(dir, file);
    const raw = await readFile(path, 'utf8');
    out.push(parseSkill(raw, path));
  }
  return out;
}

export function parseSkill(raw: string, path: string): Skill {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    throw new Error(`skill ${path} is missing frontmatter`);
  }
  const frontmatter = parseFrontmatter(m[1] ?? '');
  const body = (m[2] ?? '').trim();
  const name = String(frontmatter.name ?? '');
  if (!name) throw new Error(`skill ${path} has no "name" in frontmatter`);
  return { name, frontmatter, body, path };
}

/**
 * Tiny YAML-ish frontmatter parser — covers the subset our skills use:
 * scalar key/value, list of strings (`- foo`), nested simple keys ignored.
 * For anything richer we'd swap in `yaml`, but this keeps skills package zero-dep.
 */
function parseFrontmatter(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    if (line.startsWith('  - ') && currentKey && currentList) {
      currentList.push(line.slice(4).trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (line.startsWith('- ') && currentKey && currentList) {
      currentList.push(line.slice(2).trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (value === '') {
      currentKey = key;
      currentList = [];
      out[key] = currentList;
    } else {
      out[key] = stripQuotes(value);
      currentKey = null;
      currentList = null;
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Pick the skill whose name matches, otherwise the first one declared. */
export function selectSkill(skills: Skill[], name: string): Skill {
  const found = skills.find((s) => s.name === name);
  if (!found) {
    throw new Error(
      `skill "${name}" not found; have: ${skills.map((s) => s.name).join(', ') || '(none)'}`,
    );
  }
  return found;
}
