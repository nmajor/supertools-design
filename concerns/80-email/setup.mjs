#!/usr/bin/env node
// supertools-design 80-email setup
//
// Idempotent. Run from a bootstrapped project root.
// Args: <test-recipient-email>
// Reads env from .env if present; required vars listed in requires.json.

import fs from 'node:fs/promises';
import { loadDotenv, readProjectState, requireEnv, ahasend, cf, emailDomainFor } from './_lib.mjs';

const log = (...a) => console.log(...a);
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

async function ensureAhasendDomain(emailDomain) {
  log(`[1/5] Looking up Ahasend domain ${emailDomain}...`);
  const list = await ahasend('/domains?limit=200');
  if (!list.ok) die(`Ahasend list domains failed (${list.status}): ${JSON.stringify(list.body)}`);
  const existing = (list.body.data || []).find((d) => d.domain === emailDomain);
  if (existing) {
    log(`[1/5] Found existing (id: ${existing.id}, dns_valid: ${existing.dns_valid})`);
    // Re-fetch to get fresh dns_records
    const fresh = await ahasend(`/domains/${encodeURIComponent(emailDomain)}`);
    if (!fresh.ok) die(`Ahasend get domain failed: ${JSON.stringify(fresh.body)}`);
    return fresh.body;
  }
  log(`[1/5] Not found — creating...`);
  const created = await ahasend('/domains', {
    method: 'POST',
    body: JSON.stringify({ domain: emailDomain }),
  });
  if (!created.ok) die(`Ahasend create domain failed (${created.status}): ${JSON.stringify(created.body)}`);
  log(`[1/5] Created (id: ${created.body.id})`);
  return created.body;
}

async function findCfZone(rootDomain) {
  log(`[2/5] Looking up Cloudflare zone ${rootDomain}...`);
  const r = await cf(
    `/zones?name=${encodeURIComponent(rootDomain)}&account.id=${process.env.CLOUDFLARE_ACCOUNT_ID}`
  );
  if (!r.ok) die(`CF list zones failed: ${JSON.stringify(r.body)}`);
  const z = (r.body.result || [])[0];
  if (!z) die(`CF zone not found for ${rootDomain} in account ${process.env.CLOUDFLARE_ACCOUNT_ID}`);
  log(`[2/5] Found zone (id: ${z.id})`);
  return z;
}

async function ensureDnsRecord(zoneId, rec) {
  // List existing records by name+type to avoid creating duplicates.
  const listR = await cf(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(rec.host)}&type=${rec.type}`
  );
  if (!listR.ok) {
    const isAuth = (listR.body.errors || []).some(
      (e) => e.code === 10000 || /Authentication/i.test(e.message || '')
    );
    if (isAuth) {
      die(
        `CF token doesn't have DNS access to this zone. ` +
        `Update the token's zone scope (https://dash.cloudflare.com/profile/api-tokens) ` +
        `to include this domain, then re-run.\n` +
        `Underlying error: ${JSON.stringify(listR.body.errors || listR.body)}`
      );
    }
    die(`CF list records failed: ${JSON.stringify(listR.body)}`);
  }
  const existing = listR.body.result || [];

  const exact = existing.find((e) => normalize(e.content) === normalize(rec.content));
  if (exact) {
    log(`[3/5]   skipped ${rec.type} ${rec.host} (already exact)`);
    return exact;
  }

  if (existing.length > 0) {
    die(
      `[3/5]   conflict: ${rec.type} ${rec.host} exists with different content. ` +
      `Existing: ${JSON.stringify(existing.map((e) => e.content))}. Expected: ${rec.content}. ` +
      `Resolve manually and re-run.`
    );
  }

  const create = await cf(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({
      type: rec.type,
      name: rec.host,
      content: rec.content,
      ttl: 1, // automatic
      proxied: false,
    }),
  });
  if (!create.ok) {
    die(`CF create record failed for ${rec.type} ${rec.host}: ${JSON.stringify(create.body.errors || create.body)}`);
  }
  log(`[3/5]   created ${rec.type} ${rec.host}`);
  return create.body.result;
}

function normalize(s) {
  // CF and Ahasend may differ in whitespace/quoting on TXT contents.
  return String(s).trim().replace(/^"+|"+$/g, '').replace(/\s+/g, ' ');
}

async function pollAhasendValidation(emailDomain, timeoutMs = 15 * 60 * 1000) {
  log(`[4/5] Waiting for DNS propagation + Ahasend validation (timeout ${Math.round(timeoutMs / 60000)}min)...`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await ahasend(`/domains/${encodeURIComponent(emailDomain)}`);
    if (!r.ok) die(`Ahasend get domain failed: ${JSON.stringify(r.body)}`);
    const required = (r.body.dns_records || []).filter((rec) => rec.required);
    const propagated = required.filter((rec) => rec.propagated).length;
    const elapsed = Math.round((Date.now() - start) / 1000);
    log(`[4/5]   ${elapsed}s: dns_valid=${r.body.dns_valid} (${propagated}/${required.length} required propagated)`);
    if (r.body.dns_valid) return r.body;
    await new Promise((res) => setTimeout(res, 30_000));
  }
  die(`[4/5] Timed out after ${Math.round(timeoutMs / 60000)} minutes. DNS may still propagate; re-run setup later.`);
}

async function sendTestEmail(emailDomain, recipient, projectName) {
  log(`[5/5] Sending test email from hello@${emailDomain} to ${recipient}...`);
  const r = await ahasend('/messages', {
    method: 'POST',
    body: JSON.stringify({
      from: { name: projectName, email: `hello@${emailDomain}` },
      recipients: [{ email: recipient }],
      subject: `Test email from ${emailDomain}`,
      text_content:
        `This is a test email sent during the supertools-design 80-email bootstrap step.\n\n` +
        `If you received this, transactional email is working for ${emailDomain}.`,
      html_content:
        `<p>This is a test email sent during the supertools-design <code>80-email</code> bootstrap step.</p>` +
        `<p>If you received this, transactional email is working for <strong>${emailDomain}</strong>.</p>`,
    }),
  });
  if (!r.ok) die(`Ahasend send failed (${r.status}): ${JSON.stringify(r.body)}`);
  log(`[5/5] Sent.`);
  return r.body;
}

async function ensureEnvVar(file, key, value) {
  let text = '';
  try { text = await fs.readFile(file, 'utf-8'); } catch {}
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.match(new RegExp(`^\\s*${key}\\s*=`)));
  if (idx >= 0) {
    if (lines[idx].trim() === `${key}=${value}`) return;
    lines[idx] = `${key}=${value}`;
  } else {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${key}=${value}`);
  }
  await fs.writeFile(file, lines.join('\n'));
}

async function main() {
  await loadDotenv();
  requireEnv(['AHASEND_API_KEY', 'AHASEND_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);

  const state = await readProjectState();
  if (!state || !state.domain) die('Could not read .supertools-state/project.json (or it has no "domain"). Run /supertools-design:bootstrap first.');

  const emailDomain = emailDomainFor(state.domain);
  const recipient = process.argv[2];
  if (!recipient) die('Usage: setup.mjs <test-recipient-email>');

  const projectName = state.projectName || state.domain.split('.')[0];

  const ahasendDomain = await ensureAhasendDomain(emailDomain);
  const zone = await findCfZone(state.domain);

  const requiredRecords = (ahasendDomain.dns_records || []).filter((r) => r.required);
  log(`[3/5] Ensuring ${requiredRecords.length} required DNS records...`);
  for (const rec of requiredRecords) {
    await ensureDnsRecord(zone.id, rec);
  }

  const validated = await pollAhasendValidation(emailDomain);

  await sendTestEmail(emailDomain, recipient, projectName);
  const sentAt = new Date().toISOString();

  await ensureEnvVar('.env', 'AHASEND_FROM_EMAIL', `hello@${emailDomain}`);
  await ensureEnvVar('.env', 'AHASEND_FROM_DOMAIN', emailDomain);
  log(`Wrote AHASEND_FROM_EMAIL and AHASEND_FROM_DOMAIN to .env`);

  // Print machine-readable summary the orchestrator can capture for the receipt.
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify({
    emailDomain,
    fromAddress: `hello@${emailDomain}`,
    ahasendDomainId: validated.id,
    testEmailSentTo: recipient,
    testEmailSentAt: sentAt,
  }, null, 2));
}

main().catch((e) => die(e.stack || e.message || String(e)));
