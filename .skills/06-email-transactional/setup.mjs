#!/usr/bin/env node
// 06-email-transactional setup.
// Lineage: originated in the supertools toolchain; adapted for this project.
// Idempotent. Optional arg: <test-recipient-email>.

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadEnv, requireEnv, writeEnvVar, PROJECT_ROOT } from '../_shared/env.mjs';
import { ahasend, emailDomainFor } from '../_shared/ahasend.mjs';
import { cf, findZoneId } from '../_shared/cf.mjs';
import { appendRalphRequirement } from '../_shared/state.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '06-email-transactional');

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

function normalize(s) {
  return String(s).trim().replace(/^"+|"+$/g, '').replace(/\s+/g, ' ');
}

async function readDomain() {
  const j = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8'));
  if (!j.domain) die('project.json has no "domain" — run skill 00.');
  return j.domain;
}

async function ensureAhasendDomain(emailDomain) {
  log(`[1/5] Looking up Ahasend domain ${emailDomain}...`);
  const list = await ahasend('/domains?limit=100');
  if (!list.ok) die(`Ahasend list domains failed (${list.status}): ${JSON.stringify(list.body)}`);
  const existing = (list.body.data || []).find((d) => d.domain === emailDomain);
  if (existing) {
    log(`[1/5] Found existing (id: ${existing.id}, dns_valid: ${existing.dns_valid})`);
    const fresh = await ahasend(`/domains/${encodeURIComponent(emailDomain)}`);
    if (!fresh.ok) die(`Ahasend get domain failed: ${JSON.stringify(fresh.body)}`);
    return fresh.body;
  }
  log(`[1/5] Not found — creating...`);
  const created = await ahasend('/domains', { method: 'POST', body: JSON.stringify({ domain: emailDomain }) });
  if (!created.ok) die(`Ahasend create domain failed (${created.status}): ${JSON.stringify(created.body)}`);
  log(`[1/5] Created (id: ${created.body.id})`);
  return created.body;
}

async function ensureDnsRecord(zoneId, rec) {
  const listR = await cf(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(rec.host)}&type=${rec.type}`);
  if (!listR.ok) {
    const isAuth = (listR.body.errors || []).some((e) => e.code === 10000 || /Authentication/i.test(e.message || ''));
    if (isAuth) {
      die(`CF token doesn't have DNS access to this zone. Update the token's zone scope ` +
        `(https://dash.cloudflare.com/profile/api-tokens), then re-run.\n` +
        `Underlying error: ${JSON.stringify(listR.body.errors || listR.body)}`);
    }
    die(`CF list records failed: ${JSON.stringify(listR.body)}`);
  }
  const existing = listR.body.result || [];
  const exact = existing.find((e) => normalize(e.content) === normalize(rec.content));
  // A differing same-name/type record is a conflict even if an exact match
  // also exists — e.g. two TXT at the SPF/DMARC name breaks validation.
  const conflicting = existing.filter((e) => normalize(e.content) !== normalize(rec.content));
  if (conflicting.length > 0) {
    die(`[3/5]   conflict: ${rec.type} ${rec.host} has ${conflicting.length} record(s) with different content. ` +
      `Conflicting: ${JSON.stringify(conflicting.map((e) => e.content))}. Expected: ${rec.content}. ` +
      `Two records at the same name (esp. SPF/DMARC) break email — resolve manually and re-run.`);
  }
  if (exact) { log(`[3/5]   skip ${rec.type} ${rec.host} (already exact)`); return { action: 'skipped', ...rec }; }
  const create = await cf(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: rec.type, name: rec.host, content: rec.content, ttl: 1, proxied: false }),
  });
  if (!create.ok) die(`CF create record failed for ${rec.type} ${rec.host}: ${JSON.stringify(create.body.errors || create.body)}`);
  log(`[3/5]   created ${rec.type} ${rec.host}`);
  return { action: 'created', ...rec };
}

async function pollValidation(emailDomain, timeoutMs = 15 * 60 * 1000) {
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
  die(`[4/5] Timed out after ${Math.round(timeoutMs / 60000)} minutes. DNS may still propagate; re-run later.`);
}

// The management key (AHASEND_SECRET_KEY / setup-key) has api-keys:write +
// domains:write but NOT messages:send. The app should send with a narrow
// domain-scoped key anyway, so mint one for email.<domain> and persist it as
// AHASEND_SEND_API_KEY. Returns the send key to use for the test send.

// Brand display name: CLAUDE.md "Brand: X ·" line, else title-cased folder name.
async function brandName() {
  try {
    const md = await fs.readFile(path.join(PROJECT_ROOT, 'CLAUDE.md'), 'utf-8');
    const m = md.match(/^Brand:\s*([^·\n]+?)\s*·/m);
    if (m) return m[1].trim();
  } catch {}
  return path.basename(PROJECT_ROOT).split(/[-_]/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

async function ensureSendKey(emailDomain) {
  const label = `${path.basename(PROJECT_ROOT)}-send`;
  const wantScope = `messages:send:{${emailDomain}}`;

  // Reuse only when we can BIND the persisted secret to a specific account
  // key: AHASEND_SEND_API_KEY_ID identifies the exact key minted alongside
  // the persisted secret. We confirm that key id still exists with the wanted
  // scope. Exact SET equality — a key carrying the wanted scope PLUS extras
  // is over-scoped and must not be blessed as the "narrow" send key.
  // FORCE_REMINT_SEND_KEY=1 skips reuse entirely — straight to rotate+mint.
  if (process.env.AHASEND_SEND_API_KEY && process.env.AHASEND_SEND_API_KEY_ID && process.env.FORCE_REMINT_SEND_KEY !== '1') {
    // Secret↔id binding: the pair is born together at mint, where we also
    // persist AHASEND_SEND_API_KEY_FPR = sha256(secret). Reuse requires the
    // recomputed fingerprint to match — this catches a mismatched env pair
    // (an over-scoped or foreign secret paired with a clean id), which no
    // API call can catch: send keys cannot self-identify, and Ahasend's
    // last_used_at updates too lazily to bind behaviorally (observed
    // unchanged minutes after a successful send).
    const fpr = createHash('sha256').update(process.env.AHASEND_SEND_API_KEY).digest('hex');
    if (!process.env.AHASEND_SEND_API_KEY_FPR) {
      die('AHASEND_SEND_API_KEY(+_ID) present but AHASEND_SEND_API_KEY_FPR missing — cannot prove the secret ' +
          'belongs to that key id. Re-run with FORCE_REMINT_SEND_KEY=1 to mint a fresh, fingerprint-bound pair ' +
          '(then update any deployed Worker secret).');
    }
    if (fpr !== process.env.AHASEND_SEND_API_KEY_FPR) {
      die('Secret↔id binding FAILED: sha256(AHASEND_SEND_API_KEY) does not match AHASEND_SEND_API_KEY_FPR. ' +
          'The persisted secret is not the one minted with this key id. Clear the trio from .env and re-run.');
    }
    const got = await ahasend(`/api-keys/${process.env.AHASEND_SEND_API_KEY_ID}`);
    const scopes = got.ok ? (got.body.scopes || []).map((s) => s.scope || s) : [];
    const scoped = scopes.length === 1 && scopes[0] === wantScope;
    if (got.ok && !scoped && scopes.includes(wantScope)) {
      die(`Persisted send key ${process.env.AHASEND_SEND_API_KEY_ID} is OVER-SCOPED (${scopes.length} scopes) — ` +
          `refusing to reuse it as the narrow send key. Delete it (or clear AHASEND_SEND_API_KEY/_ID) and re-run ` +
          `to mint a single-scope key.`);
    }
    if (scoped) {
      log(`[4.5/5] Reusing send key id ${process.env.AHASEND_SEND_API_KEY_ID} (label: ${got.body.label})`);
      return { sendKey: process.env.AHASEND_SEND_API_KEY, keyId: process.env.AHASEND_SEND_API_KEY_ID, minted: false, label: got.body.label };
    }
    log('[4.5/5] Persisted send key id missing or lacks the scope — minting fresh.');
  }

  // A same-label key that we can't bind to (no matching persisted id) might
  // be LIVE PRODUCTION's key on another machine — deleting it would break
  // real sends (checklist #10: re-runs never degrade live systems). Halt
  // with a conflict unless the operator explicitly opts into rotation.
  const before = await ahasend('/api-keys?limit=100');
  const sameLabel = (before.body.data || []).filter((k) => k.label === label);
  if (sameLabel.length > 0 && process.env.FORCE_REMINT_SEND_KEY !== '1') {
    die(
      `Ahasend already has ${sameLabel.length} key(s) labeled "${label}" that this machine cannot bind to ` +
      `(no matching AHASEND_SEND_API_KEY_ID in .env). They may be in use by a deployed Worker. ` +
      `Either restore AHASEND_SEND_API_KEY + _ID to .env, or re-run with FORCE_REMINT_SEND_KEY=1 to ` +
      `delete + re-mint (then update the Worker secret immediately).`
    );
  }
  for (const k of sameLabel) {
    await ahasend(`/api-keys/${k.id}`, { method: 'DELETE' });
    log(`[4.5/5] FORCE_REMINT_SEND_KEY=1 — removed unbound send key (${k.id}) to re-mint cleanly`);
  }

  log(`[4.5/5] Minting send-scoped API key "${label}" for ${emailDomain}...`);
  const created = await ahasend('/api-keys', {
    method: 'POST',
    body: JSON.stringify({ label, scopes: [wantScope] }),
  });
  if (!created.ok || !created.body.secret_key || !created.body.id) {
    // Never stringify a key-creating endpoint's body into logs — an abnormal
    // response could still carry secret_key (checklist #4/#5).
    const safe = { ...(created.body || {}) };
    delete safe.secret_key;
    die(`Ahasend create send key failed (${created.status}): ${JSON.stringify(safe)}`);
  }
  return { sendKey: created.body.secret_key, keyId: created.body.id, minted: true, label };
}

async function sendTestEmail(emailDomain, recipient, projectName, sendKey, replyTo) {
  log(`[5/5] Sending test email from hello@${emailDomain} (reply-to ${replyTo}) to ${recipient}...`);
  const r = await ahasend('/messages', {
    apiKey: sendKey,
    method: 'POST',
    body: JSON.stringify({
      from: { name: projectName, email: `hello@${emailDomain}` },
      reply_to: { name: `${projectName} Support`, email: replyTo },
      recipients: [{ email: recipient }],
      subject: `Test email from ${emailDomain}`,
      text_content: `Transactional email is working for ${emailDomain}.\n\nSent during the ${projectName} email-transactional bootstrap skill. Replies go to ${replyTo}.`,
      html_content: `<p>Transactional email is working for <strong>${emailDomain}</strong>.</p><p>Sent during the ${projectName} <code>email-transactional</code> bootstrap skill. Replies go to ${replyTo}.</p>`,
    }),
  });
  if (!r.ok) die(`Ahasend send failed (${r.status}): ${JSON.stringify(r.body)}`);
  log(`[5/5] Sent.`);
  return r.body;
}

async function main() {
  loadEnv();
  requireEnv(['AHASEND_API_KEY', 'AHASEND_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
  await fs.mkdir(STATE_SUB, { recursive: true });

  const domain = await readDomain();
  const emailDomain = emailDomainFor(domain);
  const recipient = process.argv[2] || process.env.TEST_INBOX || 'nick@nmajor.com';
  // Sender display name is the BRAND, derived (not hardcoded): CLAUDE.md's
  // "Brand: <name> ·" line, falling back to a title-cased project name.
  const projectName = await brandName();

  const ahasendDomain = await ensureAhasendDomain(emailDomain);
  const zoneId = await findZoneId(domain);
  log(`[2/5] CF zone ${zoneId}`);

  // Write every record Ahasend marks `required` (DKIM/SPF/DMARC — these gate
  // dns_valid) PLUS the return-path CNAME (psrp → rp.ahasend.com). The
  // return-path is technically optional but materially improves bounce
  // handling and DMARC alignment for transactional mail, so we include it.
  // The tracking / media / subscription / MX records Ahasend also offers are
  // intentionally left out (not needed; tracking conflicts with a
  // privacy-forward stance).
  const allRecords = ahasendDomain.dns_records || [];
  const isReturnPath = (r) => /(^|\.)psrp\./.test(r.host || '') || /rp\.ahasend\.com/.test(r.content || '');
  const toWrite = allRecords.filter((r) => r.required || isReturnPath(r));
  log(`[3/5] Ensuring ${toWrite.length} DNS records (${allRecords.filter((r) => r.required).length} required + return-path)...`);
  const dnsActions = [];
  for (const rec of toWrite) dnsActions.push(await ensureDnsRecord(zoneId, rec));

  const validated = await pollValidation(emailDomain);

  // From a warm branded sender on the reputation-isolated send subdomain,
  // Reply-To the root support mailbox (provisioned by skill 07 → routed into
  // Chatwoot). Replyable transactional mail beats no-reply@ — replies to lead
  // notifications and reports are real customer requests.
  const replyTo = `support@${domain}`;

  const { sendKey, keyId, minted, label } = await ensureSendKey(emailDomain);

  // PERSIST THE KEY BEFORE THE TEST SEND.
  //
  // These three writes used to sit AFTER sendTestEmail(), which die()s on
  // failure. A single Ahasend 500 on the test send therefore left a freshly
  // minted key live in their account with nothing on this machine able to bind
  // to it — the next run found an unbindable key and refused to continue,
  // requiring FORCE_REMINT_SEND_KEY=1 to clean up. Minting a credential is the
  // irreversible step; recording it must not be contingent on a later,
  // failable network call.
  //
  // Unconditional (writeEnvVar is idempotent): also covers .env recovery,
  // where a valid key pair arrives via the machine env and must be
  // re-persisted so verify's .env checks hold.
  await writeEnvVar('AHASEND_SEND_API_KEY', sendKey);
  await writeEnvVar('AHASEND_SEND_API_KEY_ID', keyId);
  await writeEnvVar('AHASEND_SEND_API_KEY_FPR', createHash('sha256').update(sendKey).digest('hex'));
  if (minted) log(`[4.5/5] Persisted send key ${keyId} to .env before sending (recoverable if the send fails)`);

  const sent = await sendTestEmail(emailDomain, recipient, projectName, sendKey, replyTo);
  const sentAt = new Date().toISOString();

  await writeEnvVar('AHASEND_FROM_EMAIL', `hello@${emailDomain}`);
  await writeEnvVar('AHASEND_FROM_DOMAIN', emailDomain);
  await writeEnvVar('AHASEND_REPLY_TO', replyTo);
  log('Wrote AHASEND_FROM_EMAIL + AHASEND_FROM_DOMAIN + AHASEND_REPLY_TO + AHASEND_SEND_API_KEY(+_ID,+_FPR) to .env');

  // The Worker's real transactional sends should use this same envelope.
  await appendRalphRequirement(
    '06-email-transactional',
    'transactional-email-envelope',
    `Worker transactional emails send via Ahasend using AHASEND_SEND_API_KEY, ` +
    `From "${projectName} <${`hello@${emailDomain}`}>", Reply-To "${replyTo}". ` +
    `Never use a no-reply address — replies must reach the support inbox.`
  );

  // Sanitized artifact: allowlisted fields only — the raw provider object
  // carries account metadata (checklist #4/#5).
  const domainArtifact = {
    id: validated.id,
    domain: validated.domain,
    dns_valid: validated.dns_valid,
    created_at: validated.created_at,
    updated_at: validated.updated_at,
  };
  await fs.writeFile(path.join(STATE_SUB, 'ahasend-domain.json'), JSON.stringify(domainArtifact, null, 2) + '\n');

  const summary = {
    emailDomain,
    fromAddress: `hello@${emailDomain}`,
    replyTo,
    ahasendDomainId: validated.id,
    dnsValid: validated.dns_valid,
    dnsRecords: dnsActions.map((a) => ({ type: a.type, host: a.host, action: a.action })),
    sendKey: { label, keyId, minted, scope: `messages:send:{${emailDomain}}`, persistedAs: 'AHASEND_SEND_API_KEY (+ AHASEND_SEND_API_KEY_ID)' },
    testEmailSentTo: recipient,
    testEmailSentAt: sentAt,
    completedAt: new Date().toISOString(),
  };
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
