#!/usr/bin/env node
// 08-support-chat verifier.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { platform, app } from '../_shared/chatwoot.mjs';

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };

async function main() {
  loadEnv();
  requireEnv(['CHATWOOT_HOST', 'CHATWOOT_PLATFORM_ACCESS_TOKEN', 'CHATWOOT_ACCESS_TOKEN', 'CHATWOOT_ACCOUNT_ID', 'MXROUTE_SERVER']);
  const project = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8'));
  const domain = project.domain;
  const accountId = process.env.CHATWOOT_ACCOUNT_ID;
  const server = process.env.MXROUTE_SERVER;

  const acct = await platform(`/platform/api/v1/accounts/${accountId}`);
  acct.ok ? pass(`account ${accountId} exists`, acct.body.name) : fail(`account ${accountId} exists`, JSON.stringify(acct.body).slice(0, 120));

  // owner resolved from CHATWOOT_ACCESS_TOKEN must be present AND admin here.
  const prof = await app('/api/v1/profile');
  const ownerEmail = prof.body?.email;
  const agents = await app(`/api/v1/accounts/${accountId}/agents`);
  const ownerAgent = (agents.body || []).find((a) => a.email === ownerEmail);
  ownerAgent && ownerAgent.role === 'administrator'
    ? pass('owner present + administrator', `${ownerEmail}`)
    : fail('owner present + administrator', ownerAgent ? `${ownerEmail} role=${ownerAgent.role}` : `${ownerEmail} not an agent on account ${accountId}`);

  // inboxes
  const inboxes = (await app(`/api/v1/accounts/${accountId}/inboxes`)).body?.payload || [];
  const byName = (n) => inboxes.find((i) => i.name === n);
  const web = byName('Website chat');
  web && /webwidget/i.test(web.channel_type || '') ? pass('Website chat inbox (web_widget)', `id ${web.id}`) : fail('Website chat inbox (web_widget)', `missing or wrong channel (${web?.channel_type})`);

  // Email inboxes: assert channel points at MXroute (address/ports/email).
  for (const [name, email] of [['Support email', `support@${domain}`], ['Privacy email', `privacy@${domain}`]]) {
    const stub = byName(name);
    if (!stub) { fail(`${name} inbox`, 'missing'); continue; }
    const ib = (await app(`/api/v1/accounts/${accountId}/inboxes/${stub.id}`)).body;
    const okChan = /email/i.test(ib.channel_type || '');
    const okImap = ib.imap_address === server && Number(ib.imap_port) === 993;
    const okSmtp = ib.smtp_address === server && Number(ib.smtp_port) === 465;
    const okEmail = ib.email === email;
    okChan && okImap && okSmtp && okEmail
      ? pass(`${name} → MXroute`, `${email} imap:993 smtp:465`)
      : fail(`${name} → MXroute`, `chan=${ib.channel_type} email=${ib.email} imap=${ib.imap_address}:${ib.imap_port} smtp=${ib.smtp_address}:${ib.smtp_port}`);
  }

  // env persistence
  let env = '';
  try { env = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf-8'); } catch {}
  for (const key of ['CHATWOOT_ACCOUNT_ID', 'CHATWOOT_WEBSITE_INBOX_ID', 'CHATWOOT_WEBSITE_TOKEN', 'CHATWOOT_SUPPORT_INBOX_ID', 'CHATWOOT_PRIVACY_INBOX_ID']) {
    new RegExp(`^${key}=.+$`, 'm').test(env) ? pass(`${key} in .env`) : fail(`${key} in .env`, 'missing');
  }

  // assignment automations — assert one CORRECT rule per inbox (active,
  // conversation_created, inbox_id condition == that inbox, assign_agent owner).
  const rules = (await app(`/api/v1/accounts/${accountId}/automation_rules`)).body?.payload || [];
  const ownerId = ownerAgent?.id ?? prof.body?.id;
  const correctFor = (inboxId) => rules.some((r) =>
    r.active === true &&
    r.event_name === 'conversation_created' &&
    (r.conditions || []).some((c) => c.attribute_key === 'inbox_id' && (c.values || []).map(String).includes(String(inboxId))) &&
    (r.actions || []).some((a) => a.action_name === 'assign_agent' && (a.action_params || []).map(String).includes(String(ownerId))));
  for (const [label, inbox] of [['Website chat', web], ['Support email', byName('Support email')], ['Privacy email', byName('Privacy email')]]) {
    if (!inbox) { fail(`auto-assign rule: ${label}`, 'inbox missing'); continue; }
    correctFor(inbox.id)
      ? pass(`auto-assign rule: ${label}`, `→ owner ${ownerId}`)
      : fail(`auto-assign rule: ${label}`, `no active conversation_created rule assigning inbox ${inbox.id} to owner ${ownerId}`);
  }

  let okCount = 0;
  for (const c of checks) { console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`); if (c.ok) okCount++; }
  console.log(`\n${okCount}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
