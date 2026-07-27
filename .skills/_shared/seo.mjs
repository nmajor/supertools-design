// Shared plumbing for the seo-* pipeline: the handoff contract between stages.
// Every seo skill produces a versioned artifact + receipt; downstream stages
// read the upstream artifact through here so the chain fails loud on missing or
// stale inputs. See docs/seo/seo-pipeline-spec.md §2.3 + §6.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './state.mjs';

export function hashObj(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

// Canonical slug used at EVERY stage so one target maps to one slug end-to-end
// (briefs -> pages -> links). Critical for the chain.
export function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Read an upstream skill's artifact. Asserts its receipt ran ok, then loads the
// named data file from that skill's workdir. Throws a clear "run X first" error.
export async function readUpstream(producerId, file) {
  const receiptPath = path.join(STATE_DIR, `${producerId}.json`);
  if (!fs.existsSync(receiptPath)) {
    throw new Error(`Upstream "${producerId}" has not run (no receipt). Run that skill first.`);
  }
  const receipt = JSON.parse(await fsp.readFile(receiptPath, 'utf-8'));
  if (receipt.status !== 'ok') {
    throw new Error(`Upstream "${producerId}" receipt status is "${receipt.status}", expected "ok".`);
  }
  const dataPath = path.join(STATE_DIR, producerId, file);
  if (!fs.existsSync(dataPath)) {
    throw new Error(`Upstream artifact missing: ${dataPath}. Re-run "${producerId}".`);
  }
  const data = JSON.parse(await fsp.readFile(dataPath, 'utf-8'));
  return { data, hash: hashObj(data), path: dataPath, receipt };
}

// Assert an artifact's schema major version matches what this consumer speaks.
// "page-briefs@1" -> major "1". Throws on mismatch.
export function assertSchema(data, expected) {
  const got = data?.schema_version;
  if (!got) throw new Error(`Artifact missing schema_version (expected ${expected}).`);
  const major = (s) => String(s).split('@')[1]?.split('.')[0] ?? String(s).split('@')[1];
  if (String(got).split('@')[0] !== String(expected).split('@')[0] || major(got) !== major(expected)) {
    throw new Error(`Schema mismatch: artifact is "${got}", consumer expects "${expected}".`);
  }
  return true;
}

// Build the consumes[] block recorded in a consumer's receipt, for staleness.
export function recordConsumes(entries) {
  const at = new Date().toISOString();
  return entries.map((e) => ({ ...e, at }));
}


// Generic disk cache: diskCache(dir, key, async () => value). Stores JSON.
// Used to make crawls / research / SERP calls idempotent + cheap on re-run.
export async function diskCache(dir, key, producer, { noCache = false } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const safe = key.replace(/[^\w.-]/g, '_').slice(0, 120);
  const file = path.join(dir, `${safe}.${hashObj(key)}.json`);
  if (!noCache && fs.existsSync(file)) {
    return { value: JSON.parse(await fsp.readFile(file, 'utf-8')), cached: true };
  }
  const value = await producer();
  await fsp.writeFile(file, JSON.stringify(value));
  return { value, cached: false };
}

// ---- small skeleton helpers (de-dupe the per-skill setup.mjs boilerplate) ----

// Read a `--flag value` argument out of argv.
export function pickArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

// Select one brief by --slug (exact) or --only (keyword exact-or-substring), else first.
export function selectBrief(briefs, { only, slug } = {}) {
  if (slug) return (briefs || []).find((b) => b.slug === slug);
  if (only) {
    const q = only.toLowerCase().trim();
    return (briefs || []).find(
      (b) => b.primary_keyword.toLowerCase() === q || b.primary_keyword.toLowerCase().includes(q)
    );
  }
  return (briefs || [])[0];
}

// Merge an entry into a JSON registry file keyed by slug (replace same-slug, append).
// Returns the updated array. Used by skills that accumulate a per-slug registry.
export async function mergeBySlug(filePath, key, entry) {
  let existing = {};
  try { existing = JSON.parse(await fsp.readFile(filePath, 'utf-8')); } catch {}
  const arr = (existing[key] || []).filter((e) => e.slug !== entry.slug);
  arr.push(entry);
  return arr;
}

// Standard `---SETUP_DONE---` + JSON tail every skill prints on success.
export function printDone(summary) {
  console.log('\n---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

// Has the upstream artifact changed since the consumer last recorded it?
// Returns null if the consumer hasn't run, true/false otherwise. (verify.mjs uses
// this to flag a stale chain, per seo-pipeline-spec.md §2.3.4 / §7.)
export async function staleAgainst(consumerId, producerId, currentHash) {
  const receiptPath = path.join(STATE_DIR, `${consumerId}.json`);
  if (!fs.existsSync(receiptPath)) return null;
  try {
    const receipt = JSON.parse(await fsp.readFile(receiptPath, 'utf-8'));
    const prior = (receipt.consumes || []).find((c) => c.producerId === producerId);
    return prior ? prior.hash !== currentHash : null;
  } catch {
    return null;
  }
}
