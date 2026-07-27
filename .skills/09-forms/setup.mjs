#!/usr/bin/env node
// 09-forms setup.
// Chatwoot API-channel inboxes (Contact/Privacy) + Worker routes that push
// form submissions into them. Adapted from the tmp privacy-form POC.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv, requireEnv, writeEnvVar, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';
import { app, chatwootBase } from '../_shared/chatwoot.mjs';
import { appendRalphRequirement } from '../_shared/state.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(SKILL_DIR, 'templates');
const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '09-forms');

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

const INBOXES = [
  { name: 'Contact form', envKey: 'CHATWOOT_CONTACT_INBOX_IDENTIFIER', varKey: 'CHATWOOT_CONTACT_INBOX_IDENTIFIER' },
  { name: 'Privacy form', envKey: 'CHATWOOT_PRIVACY_INBOX_IDENTIFIER', varKey: 'CHATWOOT_PRIVACY_INBOX_IDENTIFIER' },
];

// JSONC-tolerant strip (comments + trailing commas). Comments lost on rewrite.
function stripJsonc(t) {
  let o = '', i = 0, s = false;
  while (i < t.length) {
    const c = t[i];
    if (s) { o += c; if (c === '\\' && i + 1 < t.length) { o += t[i + 1]; i += 2; continue; } if (c === '"') s = false; i++; }
    else if (c === '"') { s = true; o += c; i++; }
    else if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; }
    else if (c === '/' && t[i + 1] === '*') { i += 2; while (i < t.length - 1 && !(t[i] === '*' && t[i + 1] === '/')) i++; i += 2; }
    else { o += c; i++; }
  }
  return o.replace(/,(\s*[}\]])/g, '$1');
}

async function ensureApiInbox(accountId, name) {
  const list = (await app(`/api/v1/accounts/${accountId}/inboxes`)).body?.payload || [];
  let ib = list.find((i) => i.name === name);
  if (!ib) {
    log(`[inbox] creating API inbox "${name}"`);
    const r = await app(`/api/v1/accounts/${accountId}/inboxes`, {
      method: 'POST',
      body: JSON.stringify({ name, channel: { type: 'api' } }),
    });
    if (!r.ok) die(`Create API inbox ${name} failed (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
    ib = r.body;
  } else {
    log(`[inbox] "${name}" exists (${ib.id})`);
  }
  const full = (await app(`/api/v1/accounts/${accountId}/inboxes/${ib.id}`)).body;
  if (!full.inbox_identifier) die(`API inbox ${name} has no inbox_identifier`);
  return { id: full.id, identifier: full.inbox_identifier };
}

async function ensureOwnerMember(accountId, inboxId, ownerId) {
  const r = await app(`/api/v1/accounts/${accountId}/inbox_members`, {
    method: 'POST', body: JSON.stringify({ inbox_id: inboxId, user_ids: [ownerId] }),
  });
  // "already a member" (422/exists) is fine; anything else is a hard error —
  // the receipt claims owner membership, so don't silently continue.
  if (!r.ok && !/already|exists|422/i.test(JSON.stringify(r.body))) {
    die(`Add owner to inbox ${inboxId} failed (${r.status}): ${JSON.stringify(r.body).slice(0, 160)}`);
  }
}

function ruleIsCorrect(rule, inboxId, ownerId) {
  if (!rule || rule.active !== true || rule.event_name !== 'conversation_created') return false;
  const cond = (rule.conditions || []).find((c) => c.attribute_key === 'inbox_id');
  const condOk = cond && (cond.values || []).map(String).includes(String(inboxId));
  const act = (rule.actions || []).find((a) => a.action_name === 'assign_agent');
  return Boolean(condOk && act && (act.action_params || []).map(String).includes(String(ownerId)));
}

async function ensureAutomation(accountId, inboxId, ruleName, ownerId, rules) {
  const def = {
    name: ruleName, description: 'Assign new form conversations to the owner.',
    event_name: 'conversation_created', active: true,
    conditions: [{ attribute_key: 'inbox_id', filter_operator: 'equal_to', values: [inboxId], query_operator: null }],
    actions: [{ action_name: 'assign_agent', action_params: [ownerId] }],
  };
  const found = rules.find((r) => r.name === ruleName);
  if (found && ruleIsCorrect(found, inboxId, ownerId)) { log(`[automation] ${ruleName} correct`); return; }
  const r = found
    ? await app(`/api/v1/accounts/${accountId}/automation_rules/${found.id}`, { method: 'PATCH', body: JSON.stringify(def) })
    : await app(`/api/v1/accounts/${accountId}/automation_rules`, { method: 'POST', body: JSON.stringify(def) });
  if (!r.ok) die(`${found ? 'Repair' : 'Create'} automation ${ruleName} failed: ${JSON.stringify(r.body).slice(0, 160)}`);
  log(`[automation] ${found ? 'repaired' : 'created'} ${ruleName}`);
}

async function patchWranglerVars(host, identifiers) {
  const p = path.join(PROJECT_ROOT, 'wrangler.jsonc');
  const cfg = JSON.parse(stripJsonc(await fs.readFile(p, 'utf-8')));
  cfg.vars = { ...(cfg.vars || {}), CHATWOOT_HOST: host, ...identifiers };
  await fs.writeFile(p, JSON.stringify(cfg, null, 2) + '\n');
  log('[worker] wrangler.jsonc vars upserted');
}

async function writeDevVars(host, identifiers) {
  // Non-destructive upsert: preserve any unrelated local Worker vars/secrets
  // already in .dev.vars; only set/replace our keys.
  const p = path.join(PROJECT_ROOT, '.dev.vars');
  let text = '';
  try { text = await fs.readFile(p, 'utf-8'); } catch {}
  const want = { CHATWOOT_HOST: host, ...identifiers };
  let lines = text.length ? text.split('\n') : [];
  for (const [k, v] of Object.entries(want)) {
    const re = new RegExp(`^\\s*${k}\\s*=`);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  lines = lines.filter((l, i) => !(l === '' && i === lines.length - 1)); // trim trailing blank
  await fs.writeFile(p, lines.join('\n') + '\n');
  log('[worker] .dev.vars upserted (preserving unrelated keys)');
}

async function copyTemplates() {
  await fs.mkdir(path.join(PROJECT_ROOT, 'src', 'lib'), { recursive: true });
  await fs.mkdir(path.join(PROJECT_ROOT, 'src', 'routes', 'api'), { recursive: true });
  await fs.mkdir(path.join(PROJECT_ROOT, 'src', 'components'), { recursive: true });
  await fs.copyFile(path.join(TPL, 'chatwoot-forms.ts'), path.join(PROJECT_ROOT, 'src', 'lib', 'chatwoot-forms.ts'));
  await fs.copyFile(path.join(TPL, 'routes-api', 'contact.ts'), path.join(PROJECT_ROOT, 'src', 'routes', 'api', 'contact.ts'));
  await fs.copyFile(path.join(TPL, 'routes-api', 'privacy.ts'), path.join(PROJECT_ROOT, 'src', 'routes', 'api', 'privacy.ts'));
  // Minimal working form PAGES (post to the API routes above). The funnel
  // sections are built by the implementation loop; these utility pages have
  // no design-system spec, so the skill ships clean working versions.
  await fs.copyFile(path.join(TPL, 'SupportForm.tsx'), path.join(PROJECT_ROOT, 'src', 'components', 'SupportForm.tsx'));
  // These two carry a __BRAND_NAME__ token in their <title>.
  const brand = readProject().brandName;
  for (const page of ['contact.tsx', 'privacy-request.tsx']) {
    const tpl = await fs.readFile(path.join(TPL, 'routes-pages', page), 'utf-8');
    await fs.writeFile(
      path.join(PROJECT_ROOT, 'src', 'routes', page),
      tpl.replaceAll('__BRAND_NAME__', brand));
  }
  log('[worker] wrote API routes + SupportForm + /contact + /privacy-request pages');
}

function regenTypes() {
  const r = spawnSync('npx', ['wrangler', 'types'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  if (r.status !== 0) log(`[worker] wrangler types warn: ${(r.stderr || '').slice(-200)}`);
  else log('[worker] regenerated worker-configuration.d.ts');
}

async function main() {
  loadEnv();
  requireEnv(['CHATWOOT_HOST', 'CHATWOOT_ACCESS_TOKEN', 'CHATWOOT_ACCOUNT_ID']);
  await fs.mkdir(STATE_SUB, { recursive: true });

  const accountId = process.env.CHATWOOT_ACCOUNT_ID;
  const owner = (await app('/api/v1/profile')).body;
  if (!owner?.id) die('Could not resolve owner from CHATWOOT_ACCESS_TOKEN');

  const created = [];
  const rules = (await app(`/api/v1/accounts/${accountId}/automation_rules`)).body?.payload || [];
  const identifiers = {};
  for (const def of INBOXES) {
    const inbox = await ensureApiInbox(accountId, def.name);
    await ensureOwnerMember(accountId, inbox.id, owner.id);
    await ensureAutomation(accountId, inbox.id, `Assign ${def.name} to owner`, owner.id, rules);
    await writeEnvVar(def.envKey, inbox.identifier);
    identifiers[def.varKey] = inbox.identifier;
    created.push({ name: def.name, id: inbox.id, identifier: inbox.identifier });
  }

  const host = chatwootBase();
  await patchWranglerVars(host, identifiers);
  await writeDevVars(host, identifiers);
  await copyTemplates();
  regenTypes();

  // Forms feature is complete end-to-end (pages + API + Chatwoot). The
  // implementation loop only needs to *link* to /contact + /privacy-request
  // from the funnel/footer and may restyle the pages to taste.
  await appendRalphRequirement('09-forms', 'contact-privacy-form-pages',
    `The /contact and /privacy-request form pages exist and work end-to-end ` +
    `(post to /api/contact and /api/privacy → Chatwoot). The implementation loop only needs to ` +
    `surface links to them (footer/legal pages already link /contact + /privacy-request) and may ` +
    `restyle src/components/SupportForm.tsx to match the funnel's polish.`);

  const summary = {
    accountId: Number(accountId), ownerId: owner.id,
    inboxes: created,
    workerFiles: [
      'src/lib/chatwoot-forms.ts', 'src/routes/api/contact.ts', 'src/routes/api/privacy.ts',
      'src/components/SupportForm.tsx', 'src/routes/contact.tsx', 'src/routes/privacy-request.tsx',
    ],
    envWritten: INBOXES.map((d) => d.envKey),
    wranglerVars: ['CHATWOOT_HOST', ...Object.keys(identifiers)],
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(STATE_SUB, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
