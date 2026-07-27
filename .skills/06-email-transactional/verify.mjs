#!/usr/bin/env node
// 06-email-transactional verifier.
// Confirms the Ahasend domain is registered AND dns_valid, and that
// AHASEND_FROM_* landed in .env.

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { ahasend, emailDomainFor } from '../_shared/ahasend.mjs';
import { findZoneId, listDnsRecords } from '../_shared/cf.mjs';
import { buildRedactor } from '../_shared/redact.mjs';

// Redaction by construction (authoring-checklist #5). From-address/domain/
// reply-to are deliberately non-secret (they appear in every email header).
let redact = (s) => s;
const checks = [];
const fail = (n, d = '') => { checks.push({ name: redact(n), ok: false, detail: redact(d) }); };
const pass = (n, d = '') => { checks.push({ name: redact(n), ok: true, detail: redact(d) }); };

async function main() {
  // .env load failure = reported FAIL row + exit 1, never an unhandled throw
  // (checklist #19).
  try {
    loadEnv();
  } catch (e) {
    fail('.env load', e.message);
    return report();
  }
  const rr = buildRedactor(['AHASEND_API_KEY', 'AHASEND_ACCOUNT_ID', 'AHASEND_SEND_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], ['AHASEND_FROM_EMAIL', 'AHASEND_FROM_DOMAIN', 'AHASEND_REPLY_TO', 'AHASEND_SEND_API_KEY_ID']);
  redact = rr.redact;
  const envFileKeys = rr.envFileKeys;
  // Named env rows for the FULL requires.json contract (checklist #16/#18) —
  // the CF keys are real dependencies (DNS record checks go through cf.mjs).
  for (const k of ['AHASEND_API_KEY', 'AHASEND_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    // AHASEND_API_KEY is an alias of AHASEND_SECRET_KEY set by loadEnv, so
    // .env membership is judged on either name (checklist #18: name any key
    // satisfied only by the machine env).
    const inEnvFile = envFileKeys.has(k) || (k === 'AHASEND_API_KEY' && envFileKeys.has('AHASEND_SECRET_KEY'));
    process.env[k]
      ? pass(`env: ${k}`, inEnvFile ? '' : 'machine-env only (not in .env)')
      : fail(`env: ${k}`, 'missing from merged env');
  }
  try { requireEnv(['AHASEND_API_KEY', 'AHASEND_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']); }
  catch (e) { return report(); }

  const project = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8')
  );
  const emailDomain = process.env.AHASEND_FROM_DOMAIN || emailDomainFor(project.domain);

  const r = await ahasend(`/domains/${encodeURIComponent(emailDomain)}`);
  if (r.status === 404) { fail(`ahasend domain ${emailDomain}`, 'not found'); return report(); }
  if (!r.ok) { fail(`ahasend domain ${emailDomain}`, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return report(); }
  pass(`ahasend domain ${emailDomain} exists`);
  r.body.dns_valid
    ? pass(`${emailDomain} dns_valid`)
    : fail(`${emailDomain} dns_valid`, 'dns_valid=false — re-run setup or check DNS');

  // return-path CNAME present + no duplicate/conflicting DNS at the email
  // records (two TXT at an SPF/DMARC name would break validation).
  try {
    const zoneId = await findZoneId(project.domain);
    const cnames = await listDnsRecords(zoneId, { name: `psrp.${emailDomain}`, type: 'CNAME' });
    cnames.some((c) => /rp\.ahasend\.com/.test(c.content || ''))
      ? pass('return-path CNAME present', `psrp.${emailDomain} → rp.ahasend.com`)
      : fail('return-path CNAME present', `psrp.${emailDomain} CNAME missing`);

    // No duplicate records at the SPF / DMARC / DKIM names.
    for (const [name, type] of [
      [emailDomain, 'TXT'],                              // SPF
      [`_dmarc.${emailDomain}`, 'TXT'],                  // DMARC
      [`ahasend._domainkey.${emailDomain}`, 'TXT'],      // DKIM
    ]) {
      const recs = await listDnsRecords(zoneId, { name, type });
      recs.length === 1
        ? pass(`single ${type} at ${name}`, '1 record')
        : fail(`single ${type} at ${name}`, recs.length === 0
            ? 'MISSING — record absent from the zone'
            : `${recs.length} records — duplicates break email auth`);
    }
  } catch (e) {
    // A zone/API failure must fail EVERY promised DNS row, not silently drop
    // the TXT checks (checklist #16).
    fail('return-path CNAME present', e.message);
    for (const [name, type] of [[emailDomain, 'TXT'], [`_dmarc.${emailDomain}`, 'TXT'], [`ahasend._domainkey.${emailDomain}`, 'TXT']]) {
      fail(`single ${type} at ${name}`, `not checked — zone lookup failed: ${e.message}`);
    }
  }

  // .env persistence
  let env = '';
  try { env = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf-8'); } catch {}
  new RegExp(`^AHASEND_FROM_EMAIL=hello@${emailDomain.replace(/\./g, '\\.')}$`, 'm').test(env)
    ? pass('AHASEND_FROM_EMAIL in .env')
    : fail('AHASEND_FROM_EMAIL in .env', 'missing or wrong');
  new RegExp(`^AHASEND_FROM_DOMAIN=${emailDomain.replace(/\./g, '\\.')}$`, 'm').test(env)
    ? pass('AHASEND_FROM_DOMAIN in .env')
    : fail('AHASEND_FROM_DOMAIN in .env', 'missing or wrong');
  new RegExp(`^AHASEND_REPLY_TO=support@${project.domain.replace(/\./g, '\\.')}$`, 'm').test(env)
    ? pass('AHASEND_REPLY_TO in .env', `support@${project.domain}`)
    : fail('AHASEND_REPLY_TO in .env', `expected support@${project.domain} (not a no-reply address)`);

  // Send-scoped key persisted AND bound: the persisted key id must be a real
  // account key carrying exactly the wanted scope. This ties the persisted
  // secret to a specific scoped key, not just "some key has the scope".
  /^AHASEND_SEND_API_KEY=aha-sk-/m.test(env)
    ? pass('AHASEND_SEND_API_KEY in .env')
    : fail('AHASEND_SEND_API_KEY in .env', 'missing — app cannot send');
  const idMatch = env.match(/^AHASEND_SEND_API_KEY_ID=(.+)$/m);
  const wantScope = `messages:send:{${emailDomain}}`;
  if (!idMatch) {
    fail('AHASEND_SEND_API_KEY_ID in .env', 'missing — cannot bind the send key to a scoped key');
  } else {
    const keyId = idMatch[1].trim();
    const got = await ahasend(`/api-keys/${keyId}`);
    const scopes = got.ok ? (got.body.scopes || []).map((s) => s.scope || s) : [];
    (scopes.length === 1 && scopes[0] === wantScope)
      ? pass('send key bound + EXACTLY scoped', `id ${keyId} → ${wantScope}`)
      : fail('send key bound + EXACTLY scoped', !got.ok
          ? `key id ${keyId} not found`
          : scopes.includes(wantScope)
            ? `extra scopes present (${scopes.length} total) — key is over-scoped, not the narrow send key`
            : `key lacks ${wantScope}`);
    // Secret↔id binding: sha256(persisted secret) must equal the persisted
    // mint-time fingerprint (send keys cannot self-identify; last_used_at is
    // updated too lazily by the provider to bind behaviorally).
    {
      const envText = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf-8');
      const fprMatch = envText.match(/^AHASEND_SEND_API_KEY_FPR=(.+)$/m);
      const fpr = process.env.AHASEND_SEND_API_KEY ? createHash('sha256').update(process.env.AHASEND_SEND_API_KEY).digest('hex') : null;
      (fprMatch && fpr && fprMatch[1].trim() === fpr)
        ? pass('secret↔id binding (mint-time fingerprint)', 'sha256(secret) matches AHASEND_SEND_API_KEY_FPR')
        : fail('secret↔id binding (mint-time fingerprint)', !fprMatch
            ? 'AHASEND_SEND_API_KEY_FPR missing from .env — re-run setup (FORCE_REMINT_SEND_KEY=1 if needed)'
            : 'fingerprint mismatch — the persisted secret is not the one minted with this key id');
    }

  }

  // Ralph requirement promised in Outputs (checklist #20).
  try {
    const reqs = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'ralph-requirements.json'), 'utf-8'));
    reqs.some((r) => r.skillId === '06-email-transactional' && r.key === 'transactional-email-envelope')
      ? pass('transactional-email-envelope ralph requirement recorded')
      : fail('transactional-email-envelope ralph requirement recorded', 'missing from ralph-requirements.json');
  } catch (e) {
    fail('transactional-email-envelope ralph requirement recorded', `ralph-requirements.json unreadable: ${e.message}`);
  }

  report();
}

function report() {
  let ok = 0;
  for (const c of checks) {
    console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    if (c.ok) ok++;
  }
  console.log(`\n${ok}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
