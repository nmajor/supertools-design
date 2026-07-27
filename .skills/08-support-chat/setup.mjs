#!/usr/bin/env node
// 08-support-chat setup.
// Chatwoot account + website widget + support/privacy email inboxes (IMAP/SMTP
// to the MXroute mailboxes). Adapted from the tmp support POC onto _shared.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, requireEnv, writeEnvVar, PROJECT_ROOT } from '../_shared/env.mjs';
import { platform, app, chatwootBase, lisbonWorkingHours } from '../_shared/chatwoot.mjs';
import { appendRalphRequirement } from '../_shared/state.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '08-support-chat');
const ROSE = '#881337';
const TZ = 'Europe/Lisbon';

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };
const isDup = (body) => /already|taken|exists|422/i.test(JSON.stringify(body || ''));

async function readProject() {
  const j = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8'));
  // Support-facing brand name: prefer CLAUDE.md "Brand: `X`", else title-case
  // the project dir name (project.json's projectName is the lowercase dir).
  let brand = null;
  try {
    const md = await fs.readFile(path.join(PROJECT_ROOT, 'CLAUDE.md'), 'utf-8');
    brand = md.match(/Brand:\s*`([^`]+)`/)?.[1] || null;
  } catch {}
  if (!brand) {
    const base = j.projectName || path.basename(PROJECT_ROOT);
    brand = base.replace(/(^|[-_\s])([a-z])/g, (_, s, c) => (s.trim() ? ' ' : '') + c.toUpperCase());
  }
  return { domain: j.domain, projectName: brand };
}

async function ensureAccount(projectName, domain) {
  if (process.env.CHATWOOT_ACCOUNT_ID) {
    const got = await platform(`/platform/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}`);
    if (got.ok) {
      log(`[account] reusing ${process.env.CHATWOOT_ACCOUNT_ID} (${got.body.name})`);
      if (got.body.name !== projectName) {
        await platform(`/platform/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}`, {
          method: 'PATCH', body: JSON.stringify({ name: projectName }),
        });
        log(`[account] renamed → ${projectName}`);
      }
      return Number(process.env.CHATWOOT_ACCOUNT_ID);
    }
    log('[account] CHATWOOT_ACCOUNT_ID set but not found — creating fresh');
  }
  const created = await platform('/platform/api/v1/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: projectName, locale: 'en', domain: `www.${domain}`, support_email: `support@${domain}` }),
  });
  if (!created.ok) die(`Chatwoot create account failed (${created.status}): ${JSON.stringify(created.body)}`);
  log(`[account] created ${created.body.id} (${projectName})`);
  await writeEnvVar('CHATWOOT_ACCOUNT_ID', String(created.body.id));
  return created.body.id;
}

async function resolveOwnerUserId() {
  const prof = await app('/api/v1/profile');
  if (!prof.ok || !prof.body.id) die(`Could not resolve owner from CHATWOOT_ACCESS_TOKEN: ${JSON.stringify(prof.body)}`);
  return { id: prof.body.id, email: prof.body.email };
}

async function attachOwnerAdmin(accountId, ownerId) {
  const r = await platform(`/platform/api/v1/accounts/${accountId}/account_users`, {
    method: 'POST',
    body: JSON.stringify({ user_id: ownerId, role: 'administrator' }),
  });
  if (!r.ok && !isDup(r.body)) die(`Attach owner failed: ${JSON.stringify(r.body)}`);
  log(`[account] owner ${ownerId} is administrator`);
}

async function listInboxes(accountId) {
  const r = await app(`/api/v1/accounts/${accountId}/inboxes`);
  return r.body?.payload || [];
}

async function ensureWebsiteInbox(accountId, projectName, domain, existing) {
  const name = 'Website chat';
  const found = existing.find((i) => i.name === name);
  if (found) { log(`[inbox] ${name} exists (${found.id})`); return found; }
  log(`[inbox] creating ${name}`);
  const r = await app(`/api/v1/accounts/${accountId}/inboxes`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      greeting_enabled: true,
      greeting_message: `Hi, this is ${projectName} support. Send your question and we will get back to you as soon as we can.`,
      enable_email_collect: true,
      csat_survey_enabled: true,
      enable_auto_assignment: true,
      working_hours_enabled: true,
      working_hours: lisbonWorkingHours(),
      out_of_office_message: 'Thanks for reaching out. Support hours are Mon–Fri, 9:00–17:00 Lisbon time, but we still receive your message and may reply sooner.',
      timezone: TZ,
      sender_name_type: 'friendly',
      business_name: projectName,
      channel: {
        type: 'web_widget',
        website_url: `https://www.${domain}`,
        welcome_title: `Welcome to ${projectName}`,
        welcome_tagline: 'Ask a question and we will get back to you.',
        widget_color: ROSE,
      },
    }),
  });
  if (!r.ok) die(`Create website inbox failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function ensureEmailInbox(accountId, name, email, password, projectName, domain, existing) {
  const server = process.env.MXROUTE_SERVER;
  // Channel attributes WITHOUT `type` — `type` is required on create but
  // immutable on update (including it in a PATCH returns 500).
  const channelAttrs = {
    email,
    imap_enabled: true, imap_login: email, imap_password: password,
    imap_address: server, imap_port: 993, imap_enable_ssl: true,
    smtp_enabled: true, smtp_login: email, smtp_password: password,
    smtp_address: server, smtp_port: 465, smtp_domain: domain,
    smtp_enable_ssl_tls: true, smtp_enable_starttls_auto: false,
    smtp_openssl_verify_mode: 'none', smtp_authentication: 'login',
  };
  const found = existing.find((i) => i.name === name);
  if (found) {
    // PATCH the channel so re-runs correct IMAP/SMTP drift + refreshed
    // MXroute passwords (the documented stale-password recovery path).
    // A failed refresh is a hard error — silently keeping a stale channel
    // would defeat the recovery path.
    log(`[inbox] ${name} exists (${found.id}) — refreshing IMAP/SMTP`);
    const upd = await app(`/api/v1/accounts/${accountId}/inboxes/${found.id}`, {
      method: 'PATCH', body: JSON.stringify({ channel: channelAttrs }),
    });
    if (!upd.ok) die(`Refresh ${name} channel failed (${upd.status}): ${JSON.stringify(upd.body).slice(0, 200)}`);
    return upd.body;
  }
  log(`[inbox] creating ${name} (${email})`);
  const r = await app(`/api/v1/accounts/${accountId}/inboxes`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      enable_auto_assignment: true,
      csat_survey_enabled: true,
      working_hours_enabled: true,
      working_hours: lisbonWorkingHours(),
      timezone: TZ,
      sender_name_type: 'friendly',
      business_name: projectName,
      channel: { type: 'email', ...channelAttrs },
    }),
  });
  if (!r.ok) die(`Create ${name} failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function ensureOwnerMember(accountId, inboxId, ownerId) {
  const r = await app(`/api/v1/accounts/${accountId}/inbox_members`, {
    method: 'POST',
    body: JSON.stringify({ inbox_id: inboxId, user_ids: [ownerId] }),
  });
  if (!r.ok && !isDup(r.body)) log(`[inbox] add member to ${inboxId} warning: ${JSON.stringify(r.body).slice(0, 120)}`);
}

// A rule is correct iff: active, event conversation_created, a single
// inbox_id condition equal to this inbox, and an assign_agent action to the
// owner. Repair (PATCH) on drift; create if absent.
function ruleIsCorrect(rule, inboxId, ownerId) {
  if (!rule || rule.active !== true || rule.event_name !== 'conversation_created') return false;
  const cond = (rule.conditions || []).find((c) => c.attribute_key === 'inbox_id');
  const condOk = cond && (cond.values || []).map(String).includes(String(inboxId));
  const act = (rule.actions || []).find((a) => a.action_name === 'assign_agent');
  const actOk = act && (act.action_params || []).map(String).includes(String(ownerId));
  return Boolean(condOk && actOk);
}

async function ensureAssignmentAutomation(accountId, inboxId, ruleName, ownerId, existingRules) {
  const def = {
    name: ruleName,
    description: 'Assign new conversations to the owner.',
    event_name: 'conversation_created',
    active: true,
    conditions: [{ attribute_key: 'inbox_id', filter_operator: 'equal_to', values: [inboxId], query_operator: null }],
    actions: [{ action_name: 'assign_agent', action_params: [ownerId] }],
  };
  const found = existingRules.find((r) => r.name === ruleName);
  if (found && ruleIsCorrect(found, inboxId, ownerId)) { log(`[automation] ${ruleName} correct`); return; }
  if (found) {
    log(`[automation] ${ruleName} drifted — repairing (PATCH ${found.id})`);
    const r = await app(`/api/v1/accounts/${accountId}/automation_rules/${found.id}`, { method: 'PATCH', body: JSON.stringify(def) });
    if (!r.ok) die(`Repair automation ${ruleName} failed (${r.status}): ${JSON.stringify(r.body).slice(0, 160)}`);
    return;
  }
  log(`[automation] creating ${ruleName}`);
  const r = await app(`/api/v1/accounts/${accountId}/automation_rules`, { method: 'POST', body: JSON.stringify(def) });
  if (!r.ok) die(`Create automation ${ruleName} failed (${r.status}): ${JSON.stringify(r.body).slice(0, 160)}`);
}

function widgetSnippet(websiteToken) {
  const base = chatwootBase();
  return `<script>
  (function(d,t){var BASE_URL="${base}";var g=d.createElement(t),s=d.getElementsByTagName(t)[0];
  g.src=BASE_URL+"/packs/js/sdk.js";g.defer=true;g.async=true;s.parentNode.insertBefore(g,s);
  g.onload=function(){window.chatwootSDK.run({websiteToken:"${websiteToken}",baseUrl:BASE_URL});};
  })(document,"script");
</script>`;
}

async function main() {
  loadEnv();
  requireEnv(['CHATWOOT_HOST', 'CHATWOOT_PLATFORM_ACCESS_TOKEN', 'CHATWOOT_ACCESS_TOKEN', 'MXROUTE_SERVER', 'MXROUTE_SUPPORT_PASSWORD', 'MXROUTE_PRIVACY_PASSWORD']);
  await fs.mkdir(STATE_SUB, { recursive: true });

  const { domain, projectName } = await readProject();
  const accountId = await ensureAccount(projectName, domain);
  const owner = await resolveOwnerUserId();
  await attachOwnerAdmin(accountId, owner.id);

  const existing = await listInboxes(accountId);
  const web = await ensureWebsiteInbox(accountId, projectName, domain, existing);
  const support = await ensureEmailInbox(accountId, 'Support email', `support@${domain}`, process.env.MXROUTE_SUPPORT_PASSWORD, projectName, domain, existing);
  const privacy = await ensureEmailInbox(accountId, 'Privacy email', `privacy@${domain}`, process.env.MXROUTE_PRIVACY_PASSWORD, projectName, domain, existing);

  for (const inbox of [web, support, privacy]) await ensureOwnerMember(accountId, inbox.id, owner.id);

  const rules = (await app(`/api/v1/accounts/${accountId}/automation_rules`)).body?.payload || [];
  await ensureAssignmentAutomation(accountId, web.id, `Assign Website chat to owner`, owner.id, rules);
  await ensureAssignmentAutomation(accountId, support.id, `Assign Support email to owner`, owner.id, rules);
  await ensureAssignmentAutomation(accountId, privacy.id, `Assign Privacy email to owner`, owner.id, rules);

  const websiteToken = web.website_token || web.channel?.website_token;
  await writeEnvVar('CHATWOOT_WEBSITE_INBOX_ID', String(web.id));
  if (websiteToken) await writeEnvVar('CHATWOOT_WEBSITE_TOKEN', websiteToken);
  await writeEnvVar('CHATWOOT_SUPPORT_INBOX_ID', String(support.id));
  await writeEnvVar('CHATWOOT_PRIVACY_INBOX_ID', String(privacy.id));

  if (websiteToken) {
    await fs.writeFile(path.join(STATE_SUB, 'widget-embed.html'), widgetSnippet(websiteToken) + '\n');
    await appendRalphRequirement('08-support-chat', 'chat-widget',
      `Embed the Chatwoot website chat widget site-wide (script using CHATWOOT_WEBSITE_TOKEN against ${chatwootBase()}). Snippet: .supertools-state/08-support-chat/widget-embed.html.`);
  }

  const summary = {
    accountId, ownerId: owner.id, ownerEmail: owner.email,
    inboxes: {
      website: { id: web.id, token: websiteToken ? 'captured' : 'missing' },
      support: { id: support.id, email: `support@${domain}` },
      privacy: { id: privacy.id, email: `privacy@${domain}` },
    },
    envWritten: ['CHATWOOT_ACCOUNT_ID', 'CHATWOOT_WEBSITE_INBOX_ID', 'CHATWOOT_WEBSITE_TOKEN', 'CHATWOOT_SUPPORT_INBOX_ID', 'CHATWOOT_PRIVACY_INBOX_ID'],
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(STATE_SUB, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
