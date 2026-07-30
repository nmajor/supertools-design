#!/usr/bin/env node
// 01b-r2-storage setup (OPTIONAL skill).
//
// Creates the project's R2 bucket + a preview bucket and binds them in
// wrangler.jsonc. Opt-in: a project that stores no objects should skip it
// rather than create a bucket it never writes to (R2_SKIP=1 records that
// decision so the verifier can assert nothing was half-configured).
//
// Env overrides: R2_BUCKET_NAME, R2_BINDING, R2_LOCATION, R2_SKIP.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '01b-r2-storage');
const WRANGLER = path.join(PROJECT_ROOT, 'wrangler.jsonc');

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

// R2 bucket names: 3-63 chars, lowercase alphanumeric + hyphen, no leading or
// trailing hyphen. A project name that violates this must be overridden rather
// than silently mangled into something the operator did not choose.
function assertValidBucketName(name) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    die(`R2 bucket name "${name}" is invalid (3-63 chars, lowercase alphanumeric and hyphens, ` +
        'no leading/trailing hyphen). Set R2_BUCKET_NAME to override.');
  }
}

async function cfR2(method, suffix = '', body) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${acct}/r2/buckets${suffix}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const text = await r.text();
  let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { ok: r.ok, status: r.status, body: parsed };
}

// Adopt an existing bucket; never recreate and never empty one.
async function ensureBucket(name, location) {
  const list = await cfR2('GET');
  if (!list.ok) {
    die(`Could not list R2 buckets (HTTP ${list.status}). If this is 403 the token is missing ` +
        '"Workers R2 Storage: Edit" — the token used for DNS does not include R2 by default.');
  }
  const existing = (list.body.result?.buckets || []).some((b) => b.name === name);
  if (existing) { log(`  bucket ${name} already exists — adopted, not recreated`); return 'adopted'; }

  const created = await cfR2('POST', '', location ? { name, locationHint: location } : { name });
  if (!created.ok) {
    die(`Could not create R2 bucket ${name} (HTTP ${created.status}): ` +
        JSON.stringify(created.body.errors || created.body));
  }
  log(`  created bucket ${name}`);
  return 'created';
}

/* ── wrangler.jsonc splice ────────────────────────────────────────────────
 * authoring-checklist rule 12: comments are documentation and a wholesale
 * rewrite counts as leaving the project worse. The value is READ through a
 * comment-stripper, but the write is a surgical insert that leaves every other
 * byte alone. A commented-out `r2_buckets` example must not be matched — that
 * naive-match failure broke wrangler.jsonc once already.
 */
function stripJsonComments(text) {
  let out = '', i = 0, inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') { inString = true; out += c; i++; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else if (c === ',') {
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === '/' && text[j + 1] === '/') { while (j < text.length && text[j] !== '\n') j++; }
        else if (text[j] === '/' && text[j + 1] === '*') {
          j += 2;
          while (j < text.length - 1 && !(text[j] === '*' && text[j + 1] === '/')) j++;
          j += 2;
        } else break;
      }
      if (text[j] === '}' || text[j] === ']') { i++; continue; }
      out += c; i++;
    } else { out += c; i++; }
  }
  return out;
}

// Find the top-level opening brace, skipping any leading banner comment.
function topLevelBraceIndex(text) {
  let j = 0;
  for (;;) {
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === '/' && text[j + 1] === '/') { while (j < text.length && text[j] !== '\n') j++; }
    else if (text[j] === '/' && text[j + 1] === '*') {
      j += 2;
      while (j < text.length - 1 && !(text[j] === '*' && text[j + 1] === '/')) j++;
      j += 2;
    } else return text[j] === '{' ? j : -1;
  }
}

async function bindInWrangler({ binding, bucket, previewBucket }) {
  let raw;
  try { raw = await fs.readFile(WRANGLER, 'utf-8'); }
  catch { die(`No wrangler.jsonc at ${WRANGLER} — run 01-project-init first.`); }

  let cfg;
  try { cfg = JSON.parse(stripJsonComments(raw)); }
  catch (e) { die(`wrangler.jsonc is not parseable JSONC (${e.message}); refusing to edit it.`); }

  const already = (cfg.r2_buckets || []).find((b) => b.binding === binding);
  if (already) {
    if (already.bucket_name !== bucket) {
      die(`wrangler.jsonc already binds ${binding} to "${already.bucket_name}", not "${bucket}". ` +
          'Left untouched — silently repointing a binding is how production data gets orphaned. ' +
          'Reconcile by hand or set R2_BINDING to a different name.');
    }
    log(`  wrangler.jsonc already binds ${binding} -> ${bucket}`);
    return { changed: false };
  }

  const brace = topLevelBraceIndex(raw);
  if (brace < 0) die('wrangler.jsonc does not start with an object; refusing to patch blindly.');

  const block =
    '\n\t/**\n' +
    '\t * R2 object storage. The Worker reaches this as env.' + binding + ' with no\n' +
    '\t * key material in the codebase. preview_bucket_name keeps `wrangler dev\n' +
    '\t * --remote` from writing into production data.\n' +
    '\t */\n' +
    '\t"r2_buckets": [\n' +
    '\t\t{\n' +
    `\t\t\t"binding": ${JSON.stringify(binding)},\n` +
    `\t\t\t"bucket_name": ${JSON.stringify(bucket)},\n` +
    `\t\t\t"preview_bucket_name": ${JSON.stringify(previewBucket)}\n` +
    '\t\t}\n' +
    '\t],';

  const next = raw.slice(0, brace + 1) + block + raw.slice(brace + 1);

  // Prove the splice before writing: valid JSONC, the intended binding, every
  // other top-level key untouched, and no comment lost.
  let reparsed;
  try { reparsed = JSON.parse(stripJsonComments(next)); }
  catch (e) { die(`wrangler.jsonc splice produced invalid JSONC: ${e.message}`); }
  const got = (reparsed.r2_buckets || []).find((b) => b.binding === binding);
  if (!got || got.bucket_name !== bucket || got.preview_bucket_name !== previewBucket) {
    die('wrangler.jsonc splice did not yield the intended r2_buckets entry; refusing to write.');
  }
  for (const k of Object.keys(cfg)) {
    if (k === 'r2_buckets') continue;
    if (JSON.stringify(reparsed[k]) !== JSON.stringify(cfg[k])) {
      die(`wrangler.jsonc splice altered unrelated key "${k}"; refusing to write.`);
    }
  }
  const comments = (t) => (t.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) || []).map((c) => c.trim());
  const lost = comments(raw).filter((c) => !comments(next).includes(c));
  if (lost.length) die(`wrangler.jsonc splice dropped ${lost.length} comment(s); refusing to write.`);

  await fs.writeFile(WRANGLER, next);
  log(`  bound ${binding} -> ${bucket} (preview ${previewBucket}) in wrangler.jsonc`);
  return { changed: true };
}

async function regenerateTypes() {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('npm', ['run', 'cf-typegen'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  if (r.status !== 0) {
    // Types are convenience, not correctness — warn, never halt.
    log('  warning: npm run cf-typegen failed; env.' + (process.env.R2_BINDING || 'MEDIA') +
        ' may be untyped until it is re-run');
    return false;
  }
  log('  regenerated worker types');
  return true;
}

async function main() {
  loadEnv();
  requireEnv(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
  await fs.mkdir(STATE_SUB, { recursive: true });

  const { projectName } = readProject();

  if (process.env.R2_SKIP === '1') {
    // A recorded decision, not an absence. The verifier asserts no binding was
    // added, so "skipped" can never quietly mean "half-configured".
    const summary = { skipped: true, reason: 'R2_SKIP=1 — this project stores no objects', completedAt: new Date().toISOString() };
    await fs.writeFile(path.join(STATE_SUB, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    log('R2 deliberately skipped (R2_SKIP=1)');
    console.log('---SETUP_DONE---');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const bucket = process.env.R2_BUCKET_NAME || `${projectName}-media`;
  const previewBucket = `${bucket}-preview`;
  const binding = process.env.R2_BINDING || 'MEDIA';
  assertValidBucketName(bucket);
  assertValidBucketName(previewBucket);

  log('▶ Ensuring R2 buckets...');
  const bucketState = await ensureBucket(bucket, process.env.R2_LOCATION);
  const previewState = await ensureBucket(previewBucket, process.env.R2_LOCATION);

  log('▶ Binding in wrangler.jsonc...');
  const bound = await bindInWrangler({ binding, bucket, previewBucket });

  log('▶ Regenerating worker types...');
  const typed = await regenerateTypes();

  const summary = {
    skipped: false,
    binding,
    bucket,
    previewBucket,
    bucketState,
    previewState,
    wranglerChanged: bound.changed,
    typesRegenerated: typed,
    s3CredentialsMinted: false,
    note: 'No S3 access keys were created. The Worker binding needs none; minting a long-lived ' +
          'credential for a capability the product does not use yet would be a needless secret.',
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(STATE_SUB, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

// Entry-point guard (rule 15): importing this module must not create buckets.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
