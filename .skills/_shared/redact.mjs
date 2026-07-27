// Redaction-by-construction for skill verifiers/setup scripts.
// Collects every env-derived value — BOTH the raw values written in .env and
// the effective process.env values for the given key names — and strips them
// from any text before it is stored or printed. Machine env shadows .env
// (loadEnv never overrides), so shadowed .env credentials are still covered.
//
// Usage:
//   import { buildRedactor } from '../_shared/redact.mjs';
//   const { redact, envFileKeys } = buildRedactor([...requires.envRequired, ...requires.envOptional]);
//   // pass every check name/detail through redact() at the single push point

import fsSync from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './env.mjs';

// excludeKeys: env keys whose values are deliberately non-secret (e.g. a
// public check slug) — redacting them only makes logs cryptic. Use sparingly;
// every exclusion is a judgment call the skill owns.
export function buildRedactor(keyNames = [], excludeKeys = []) {
  const keys = new Set(keyNames);
  const excluded = new Set(excludeKeys);
  const envFileKeys = new Set();
  const pairs = new Map(); // value -> key (dedupe by value)
  try {
    const envText = fsSync.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf-8');
    for (const line of envText.split('\n')) {
      if (line.startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      keys.add(m[1]);
      const raw = m[2].replace(/^["']|["']$/g, '');
      if (raw.length >= 4) { envFileKeys.add(m[1]); pairs.set(raw, m[1]); }
      else if (m[2] !== '') envFileKeys.add(m[1]);
    }
  } catch {}
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.length >= 4 && !pairs.has(v)) pairs.set(v, k);
  }
  // Longest values first so overlapping values can't leave fragments behind.
  const secretValues = [...pairs.entries()]
    .map(([v, k]) => [k, v])
    .filter(([k]) => !excluded.has(k))
    .sort((a, b) => b[1].length - a[1].length);

  function redact(text) {
    let out = String(text ?? '');
    for (const [k, v] of secretValues) out = out.split(v).join(`<REDACTED:${k}>`);
    return out;
  }

  return { redact, envFileKeys };
}
