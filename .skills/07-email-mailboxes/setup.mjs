#!/usr/bin/env node
// 07-email-mailboxes setup.
// MXroute mailboxes (support@, privacy@) + authoritative MX/SPF/DKIM/DMARC
// mirrored into Cloudflare. Adapted from the tmp support POCs onto _shared.

import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import { loadEnv, requireEnv, writeEnvVar, PROJECT_ROOT } from '../_shared/env.mjs';
import { cf, findZoneId } from '../_shared/cf.mjs';
import { directAdmin, isDaError, looksAlreadyExists, mxRecords, readDaMailDns } from '../_shared/mxroute.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '07-email-mailboxes');
const MAILBOXES = [
  { local: 'support', envKey: 'MXROUTE_SUPPORT_PASSWORD' },
  { local: 'privacy', envKey: 'MXROUTE_PRIVACY_PASSWORD' },
];

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

function createPassword(length = 28) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
function normalize(s) { return String(s).trim().replace(/^"+|"+$/g, '').replace(/\s+/g, ' '); }
function qualify(name, domain) { return name.endsWith(domain) ? name : `${name}.${domain}`; }

async function readDomain() {
  const j = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8'));
  if (!j.domain) die('project.json has no "domain" — run skill 00.');
  return j.domain;
}

async function ensureDaDomain(domain, zoneId) {
  // Does DA already own it? (POP list returns "you do not own" if not.)
  const probe = await directAdmin('/CMD_API_POP', { action: 'list', domain });
  if (probe.ok && !/do not own/i.test(JSON.stringify(probe.body))) {
    log(`[mxroute] domain ${domain} already present`);
    return { created: false };
  }
  log(`[mxroute] creating domain ${domain}...`);
  let res = await directAdmin('/CMD_API_DOMAIN', {
    action: 'create', domain, ubandwidth: 'unlimited', uquota: 'unlimited', ssl: 'ON', cgi: 'OFF', php: 'OFF',
  });
  // Ownership verification dance: DA may return a TXT to prove ownership.
  const verify = parseVerification(res.body);
  if (verify) {
    log(`[mxroute] ownership proof required — adding TXT ${verify.name}`);
    await ensureCfRecord(zoneId, domain, { type: 'TXT', name: qualify(verify.name, domain), content: verify.value });
    await waitForTxt(qualify(verify.name, domain), verify.value);
    res = await directAdmin('/CMD_API_DOMAIN', {
      action: 'create', domain, ubandwidth: 'unlimited', uquota: 'unlimited', ssl: 'ON', cgi: 'OFF', php: 'OFF',
    });
  }
  if (isDaError(res.body) && !looksAlreadyExists(res.body)) {
    die(`DirectAdmin domain create failed: ${JSON.stringify(res.body)}`);
  }
  return { created: true };
}

function parseVerification(body) {
  const text = JSON.stringify(body || '');
  const name = text.match(/Record Name:\s*([A-Za-z0-9_.-]+)/)?.[1];
  const value = text.match(/Record Value:\s*([A-Za-z0-9_.=-]+)/)?.[1];
  return name && value ? { name, value } : null;
}

async function waitForTxt(name, expected, timeoutMs = 10 * 60 * 1000) {
  dns.setServers(['1.1.1.1', '8.8.8.8']);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const values = (await dns.resolveTxt(name)).map((p) => p.join(''));
      if (values.includes(expected)) { log(`[dns] verified TXT ${name}`); return; }
    } catch {}
    log(`[dns] waiting for TXT ${name} (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  die(`Timed out waiting for TXT ${name}`);
}

async function ensureMailbox(domain, mb) {
  const email = `${mb.local}@${domain}`;
  const list = await directAdmin('/CMD_API_POP', { action: 'list', domain });
  const exists = new RegExp(`"${mb.local}"|${mb.local}@${domain}`, 'i').test(JSON.stringify(list.body));
  const stored = process.env[mb.envKey];
  let password = stored || createPassword();
  let action;

  if (!exists) {
    const created = await directAdmin('/CMD_API_POP', {
      action: 'create', domain, user: mb.local, passwd: password, passwd2: password,
      quota: process.env.MAILBOX_QUOTA_MB || '1024', limit: '',
    });
    if (isDaError(created.body) && !looksAlreadyExists(created.body)) {
      die(`DirectAdmin mailbox create failed for ${email}: ${JSON.stringify(created.body)}`);
    }
    action = 'created';
  } else if (!stored) {
    // Mailbox exists but we don't have its password — reset so .env is authoritative.
    const mod = await directAdmin('/CMD_API_POP', {
      action: 'modify', domain, user: mb.local, passwd: password, passwd2: password,
    });
    if (isDaError(mod.body)) die(`DirectAdmin mailbox password reset failed for ${email}: ${JSON.stringify(mod.body)}`);
    action = 'password-reset';
  } else {
    action = 'reused';
  }

  await writeEnvVar(mb.envKey, password);
  log(`[mxroute] mailbox ${email}: ${action}`);
  return { email, action };
}

// Purpose-aware TXT conflict: only a record of the SAME kind (SPF vs SPF,
// DMARC vs DMARC, DKIM at a _domainkey name) with differing content is a
// conflict. Unrelated TXT at the same name (e.g. a site-verification token
// at the apex) is allowed to coexist.
function isTxtConflict(record, existing) {
  const expected = normalize(record.content).toLowerCase();
  const others = existing.filter((e) => normalize(e.content) !== normalize(record.content));
  if (!others.length) return null;
  const otherContents = others.map((e) => normalize(e.content).toLowerCase());
  if (expected.startsWith('v=spf1')) {
    const c = others.filter((e, i) => otherContents[i].startsWith('v=spf1'));
    return c.length ? c : null;
  }
  if (expected.startsWith('v=dmarc1')) {
    const c = others.filter((e, i) => otherContents[i].startsWith('v=dmarc1'));
    return c.length ? c : null;
  }
  if (/_domainkey/.test(record.name)) return others; // any differing TXT at the DKIM name conflicts
  return null;
}

async function ensureCfRecord(zoneId, domain, record) {
  const q = new URLSearchParams({ name: record.name, type: record.type });
  const existing = (await cf(`/zones/${zoneId}/dns_records?${q}`)).body.result || [];
  const exact = existing.find((e) =>
    normalize(e.content) === normalize(record.content) &&
    Number(e.priority || 0) === Number(record.priority || 0));
  if (exact) { log(`[cf] exists ${record.type} ${record.name}`); return { action: 'skipped', ...record }; }

  // MX coexistence is fine (multiple by priority); foreign MX is checked
  // separately in enforceMxSet(). TXT conflicts are purpose-aware.
  if (record.type === 'TXT') {
    const conflicts = isTxtConflict(record, existing);
    if (conflicts) {
      die(`DNS conflict for TXT ${record.name}: existing ${JSON.stringify(conflicts.map((e) => e.content))} ` +
        `is the same kind as but differs from expected "${record.content}". Resolve manually and re-run.`);
    }
  }
  const created = await cf(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ ttl: 1, proxied: false, comment: 'supertools 07-email-mailboxes', ...record }),
  });
  if (!created.ok) die(`CF create ${record.type} ${record.name} failed: ${JSON.stringify(created.body.errors || created.body)}`);
  log(`[cf] created ${record.type} ${record.name}`);
  return { action: 'created', ...record };
}

// After ensuring our authoritative MX records exist, halt if any FOREIGN MX
// is present at the apex — a stale MX would split inbound mail. We don't
// auto-delete (could be intentional); we surface it for manual resolution.
async function enforceMxSet(zoneId, domain) {
  const q = new URLSearchParams({ name: domain, type: 'MX' });
  const existing = (await cf(`/zones/${zoneId}/dns_records?${q}`)).body.result || [];
  const wanted = mxRecords().map((m) => m.exchange.toLowerCase().replace(/\.$/, ''));
  const foreign = existing.filter((e) => !wanted.includes(normalize(e.content).toLowerCase().replace(/\.$/, '')));
  if (foreign.length) {
    die(`Foreign MX record(s) at ${domain}: ${JSON.stringify(foreign.map((e) => `${e.priority} ${e.content}`))}. ` +
      `These would split inbound mail away from MXroute. Remove them in the CF dashboard, then re-run.`);
  }
}

async function main() {
  loadEnv();
  requireEnv(['MXROUTE_SERVER', 'MXROUTE_USERNAME', 'MXROUTE_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
  await fs.mkdir(STATE_SUB, { recursive: true });

  const domain = await readDomain();
  const zoneId = await findZoneId(domain);
  log(`[cf] zone ${zoneId}`);

  await ensureDaDomain(domain, zoneId);

  const mailboxResults = [];
  for (const mb of MAILBOXES) mailboxResults.push(await ensureMailbox(domain, mb));

  log('[mxroute] reading DKIM/SPF from DirectAdmin zone...');
  const daDns = await readDaMailDns(domain);
  await fs.writeFile(path.join(STATE_SUB, 'da-dns.json'), JSON.stringify(daDns, null, 2) + '\n');
  if (!daDns.dkim) die('Could not read DKIM from DirectAdmin yet — re-run in a minute.');

  const spf = daDns.spf || 'v=spf1 include:mxroute.com -all';
  const dmarc = 'v=DMARC1; p=none; sp=none; adkim=r; aspf=r;';
  const records = [
    ...mxRecords().map((mx) => ({ type: 'MX', name: domain, content: mx.exchange, priority: mx.priority })),
    { type: 'TXT', name: domain, content: spf },
    { type: 'TXT', name: `_dmarc.${domain}`, content: dmarc },
    { type: 'TXT', name: qualify(daDns.dkim.host, domain), content: daDns.dkim.value },
  ];

  const cfResults = [];
  for (const rec of records) cfResults.push(await ensureCfRecord(zoneId, domain, rec));
  await enforceMxSet(zoneId, domain);
  await fs.writeFile(path.join(STATE_SUB, 'cf-records.json'), JSON.stringify(cfResults, null, 2) + '\n');

  const summary = {
    domain,
    zoneId,
    mailboxes: mailboxResults,
    dkimHost: qualify(daDns.dkim.host, domain),
    dns: cfResults.map((r) => ({ type: r.type, name: r.name, priority: r.priority, action: r.action })),
    envWritten: MAILBOXES.map((m) => m.envKey),
    completedAt: new Date().toISOString(),
  };
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
