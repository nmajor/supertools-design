#!/usr/bin/env node
// 01b-r2-storage verifier.
//
// The check that matters is the object round-trip. A bucket existing proves
// only that the token can CREATE buckets; it says nothing about whether the
// Worker's binding can read and write objects. So this puts a real object,
// gets it back, compares bytes, and deletes it.
//
// If the receipt records a deliberate skip, this asserts that NO binding was
// added — "skipped" must never quietly mean "half-configured".

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { buildRedactor } from '../_shared/redact.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '01b-r2-storage');
const WRANGLER = path.join(PROJECT_ROOT, 'wrangler.jsonc');

const checks = [];
// Redaction by construction (authoring-checklist rule 5): every check name and
// detail goes through the redactor at the single push point, so no env-derived
// value can reach a log or a receipt via an error message or a CLI dump.
let redact = (s) => s; // rebuilt after loadEnv so .env values are covered
const pass = (n, d = '') => checks.push({ name: redact(n), ok: true, detail: redact(d) });
const fail = (n, d = '') => checks.push({ name: redact(n), ok: false, detail: redact(d) });

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
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') { i++; continue; }
      out += c; i++;
    } else { out += c; i++; }
  }
  return out;
}

async function listBuckets() {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/r2/buckets`, {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
  });
  if (!r.ok) return null;
  const b = await r.json();
  return (b.result?.buckets || []).map((x) => x.name);
}

function wrangler(args) {
  return spawnSync('npx', ['wrangler', ...args], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
}

async function main() {
  loadEnv();
  {
    const requires = JSON.parse(
      await fs.readFile(new URL('./requires.json', import.meta.url), 'utf-8'));
    redact = buildRedactor([...requires.envRequired, ...(requires.envOptional || [])]).redact;
  }

  let summary;
  try { summary = JSON.parse(await fs.readFile(path.join(STATE_SUB, 'summary.json'), 'utf-8')); }
  catch { fail('setup summary present', 'run setup.mjs first'); return report(); }

  const raw = await fs.readFile(WRANGLER, 'utf-8').catch(() => null);
  const cfg = raw ? JSON.parse(stripJsonComments(raw)) : {};

  // ── Deliberate-skip path ────────────────────────────────────────────────
  if (summary.skipped) {
    pass('skip is a recorded decision', summary.reason || '');
    (cfg.r2_buckets || []).length === 0
      ? pass('no R2 binding was added', 'consistent with the recorded skip')
      : fail('no R2 binding was added',
             'the receipt says skipped but wrangler.jsonc declares r2_buckets — half-configured');
    return report();
  }

  const { binding, bucket, previewBucket } = summary;

  // ── Buckets exist ───────────────────────────────────────────────────────
  const names = await listBuckets();
  if (!names) {
    fail('R2 buckets exist', 'could not list buckets (token missing "Workers R2 Storage" permission?)');
  } else {
    names.includes(bucket) ? pass(`bucket exists: ${bucket}`) : fail(`bucket exists: ${bucket}`, 'not found');
    names.includes(previewBucket)
      ? pass(`preview bucket exists: ${previewBucket}`)
      : fail(`preview bucket exists: ${previewBucket}`, 'not found');
  }

  // ── Binding declared, and pointing at the buckets that actually exist ───
  const entry = (cfg.r2_buckets || []).find((b) => b.binding === binding);
  if (!entry) {
    fail(`wrangler.jsonc binds ${binding}`, 'no r2_buckets entry with that binding');
  } else {
    entry.bucket_name === bucket
      ? pass(`wrangler.jsonc binds ${binding} -> ${bucket}`)
      : fail(`wrangler.jsonc binds ${binding} -> ${bucket}`, `points at "${entry.bucket_name}"`);
    entry.preview_bucket_name === previewBucket
      ? pass('preview_bucket_name matches')
      : fail('preview_bucket_name matches', `is "${entry.preview_bucket_name}"`);
  }

  // ── Comments survived the splice ────────────────────────────────────────
  // The scaffold's wrangler.jsonc ships explanatory block comments. Losing
  // them is a rule-12 violation even when the JSON is still valid.
  raw && /\/\*/.test(raw)
    ? pass('wrangler.jsonc still carries its block comments')
    : fail('wrangler.jsonc still carries its block comments', 'none found after the splice');

  // ── The round-trip: the only check that proves the binding works ────────
  // Unique key so concurrent runs cannot collide; namespaced so it is obvious
  // what wrote it if cleanup ever fails.
  const key = `__supertools-verify/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
  const payload = `supertools 01b-r2-storage round-trip ${new Date().toISOString()}`;
  const tmp = path.join(STATE_SUB, 'roundtrip-probe.txt');
  await fs.writeFile(tmp, payload);

  const put = wrangler(['r2', 'object', 'put', `${bucket}/${key}`, '--file', tmp, '--remote']);
  if (put.status !== 0) {
    fail('object round-trip: put', (put.stderr || put.stdout || '').slice(-400));
  } else {
    pass('object round-trip: put');

    const got = path.join(STATE_SUB, 'roundtrip-get.txt');
    const get = wrangler(['r2', 'object', 'get', `${bucket}/${key}`, '--file', got, '--remote']);
    if (get.status !== 0) {
      fail('object round-trip: get', (get.stderr || get.stdout || '').slice(-400));
    } else {
      const back = await fs.readFile(got, 'utf-8').catch(() => null);
      back === payload
        ? pass('object round-trip: bytes match')
        : fail('object round-trip: bytes match', `got ${back === null ? 'no file' : `${back.length} bytes`}`);
      await fs.rm(got, { force: true });
    }

    // Cleanup is asserted, never assumed — a probe object left behind is
    // litter in a production bucket.
    const del = wrangler(['r2', 'object', 'delete', `${bucket}/${key}`, '--remote']);
    del.status === 0
      ? pass('object round-trip: probe deleted')
      : fail('object round-trip: probe deleted',
             `probe object ${key} may remain in ${bucket} — delete it by hand`);
  }
  await fs.rm(tmp, { force: true });

  // No S3 credential should have been minted by this skill.
  summary.s3CredentialsMinted === false
    ? pass('no S3 access keys were minted', 'the Worker binding needs none')
    : fail('no S3 access keys were minted', 'setup reports minting credentials');

  return report();
}

function report() {
  let ok = 0;
  for (const c of checks) {
    console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    if (c.ok) ok++;
  }
  console.log(`\n${ok}/${checks.length} checks passed`);
  process.exit(ok === checks.length ? 0 : 1);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
