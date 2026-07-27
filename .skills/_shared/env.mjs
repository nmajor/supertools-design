// Load .env into process.env, normalize aliases, and assert required keys.
// Every skill calls loadEnv() once at the top.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the project root portably — never hardcode an absolute path, so
// the skills run on any machine / any project checkout.
//
// Priority:
//   1. PROJECT_ROOT env var (explicit override).
//   2. Derived from this module's own location. env.mjs always lives at
//      <root>/.skills/_shared/env.mjs, so the root is three dirs up.
//   3. As a sanity check, walk up from there looking for a `.skills` dir;
//      if the derived root doesn't contain one, fall back to walking up
//      from cwd. This keeps things working if the layout ever shifts.
function resolveProjectRoot() {
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;

  const hereDir = path.dirname(fileURLToPath(import.meta.url)); // .skills/_shared
  const derived = path.resolve(hereDir, '..', '..');           // project root
  if (fs.existsSync(path.join(derived, '.skills'))) return derived;

  // Fallback: walk up from cwd looking for a `.skills` directory.
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.skills'))) return dir;
    dir = path.dirname(dir);
  }
  // Last resort: the derived path (best guess).
  return derived;
}

export const PROJECT_ROOT = resolveProjectRoot();

export function loadEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }
  const text = fs.readFileSync(envPath, 'utf-8');
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '');
  }
  // AHASEND_API_KEY is the canonical name (it is what every skill and
  // requires.json asks for); AHASEND_SECRET_KEY is the legacy spelling still
  // found in older .env files. Alias BOTH ways so a project that set either
  // one satisfies every skill — the two names previously disagreed between
  // 00-prereqs and 06-email-transactional.
  if (process.env.AHASEND_SECRET_KEY && !process.env.AHASEND_API_KEY) {
    process.env.AHASEND_API_KEY = process.env.AHASEND_SECRET_KEY;
  }
  if (process.env.AHASEND_API_KEY && !process.env.AHASEND_SECRET_KEY) {
    process.env.AHASEND_SECRET_KEY = process.env.AHASEND_API_KEY;
  }
}

export function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env keys: ${missing.join(', ')}`);
  }
}

// Idempotently set KEY=value in the project root .env, preserving everything
// else. Updates the line in place if KEY exists, appends otherwise. Also
// updates process.env for the current run. Used by skills that discover
// values worth persisting (AHASEND_FROM_*, POLAR_PRODUCT_*, etc.).
export async function writeEnvVar(key, value) {
  const fsp = await import('node:fs/promises');
  const envPath = path.join(PROJECT_ROOT, '.env');
  let text = '';
  try { text = await fsp.readFile(envPath, 'utf-8'); } catch {}
  const lines = text.split('\n');
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx >= 0) {
    if (lines[idx] === `${key}=${value}`) { process.env[key] = value; return false; }
    lines[idx] = `${key}=${value}`;
  } else {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${key}=${value}`);
  }
  await fsp.writeFile(envPath, lines.join('\n'));
  process.env[key] = value;
  return true;
}
