#!/usr/bin/env node
// 09-forms verifier.
// API inboxes + env wiring + worker files + build/tsc + LIVE POST to the
// routes via vite dev (creates real Chatwoot conversations).

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { app } from '../_shared/chatwoot.mjs';

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

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

function pickFreePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
}
async function waitHttp(url, ms = 60000) {
  const start = Date.now();
  while (Date.now() - start < ms) { try { const r = await fetch(url); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  return false;
}
async function killGroup(pid) { try { process.kill(-pid, 'SIGTERM'); } catch {} await new Promise((r) => setTimeout(r, 500)); try { process.kill(-pid, 'SIGKILL'); } catch {} }

async function main() {
  loadEnv();
  requireEnv(['CHATWOOT_HOST', 'CHATWOOT_ACCESS_TOKEN', 'CHATWOOT_ACCOUNT_ID']);
  const accountId = process.env.CHATWOOT_ACCOUNT_ID;

  // API inboxes + real identifiers (keyed by name → id + identifier)
  const inboxes = (await app(`/api/v1/accounts/${accountId}/inboxes`)).body?.payload || [];
  const real = {}; // name → { id, identifier }
  const NAME_BY_ENVKEY = { CHATWOOT_CONTACT_INBOX_IDENTIFIER: 'Contact form', CHATWOOT_PRIVACY_INBOX_IDENTIFIER: 'Privacy form' };
  for (const name of ['Contact form', 'Privacy form']) {
    const stub = inboxes.find((i) => i.name === name);
    if (!stub) { fail(`API inbox ${name}`, 'missing'); continue; }
    const full = (await app(`/api/v1/accounts/${accountId}/inboxes/${stub.id}`)).body;
    real[name] = { id: full.id, identifier: full.inbox_identifier };
    /api/i.test(full.channel_type || '') && full.inbox_identifier
      ? pass(`API inbox ${name}`, `id ${full.id}`)
      : fail(`API inbox ${name}`, `channel=${full.channel_type} identifier=${!!full.inbox_identifier}`);
  }

  // Owner is a real member of both API inboxes.
  const ownerId = (await app('/api/v1/profile')).body?.id;
  for (const name of ['Contact form', 'Privacy form']) {
    if (!real[name]) continue;
    const members = (await app(`/api/v1/accounts/${accountId}/inbox_members/${real[name].id}`)).body?.payload || [];
    members.some((m) => String(m.id) === String(ownerId))
      ? pass(`owner is member of ${name}`)
      : fail(`owner is member of ${name}`, `owner ${ownerId} not in inbox ${real[name].id} members`);
  }

  // env / wrangler / .dev.vars values must EXACTLY equal the real identifiers.
  const env = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf-8').catch(() => '');
  const devVars = await fs.readFile(path.join(PROJECT_ROOT, '.dev.vars'), 'utf-8').catch(() => '');
  const wranglerRaw = await fs.readFile(path.join(PROJECT_ROOT, 'wrangler.jsonc'), 'utf-8').catch(() => '');
  let wranglerVars = {};
  try { wranglerVars = JSON.parse(stripJsonc(wranglerRaw)).vars || {}; } catch {}
  const valOf = (text, key) => (text.match(new RegExp(`^${key}=(.+)$`, 'm')) || [])[1]?.trim();

  for (const [envKey, name] of Object.entries(NAME_BY_ENVKEY)) {
    const want = real[name]?.identifier;
    if (!want) { fail(`identifier wiring ${name}`, 'no real identifier'); continue; }
    const envOk = valOf(env, envKey) === want;
    const devOk = valOf(devVars, envKey) === want;
    const wrOk = wranglerVars[envKey] === want;
    envOk && devOk && wrOk
      ? pass(`identifier wiring ${name}`, `.env/.dev.vars/wrangler all = ${want.slice(0, 8)}…`)
      : fail(`identifier wiring ${name}`, `env=${envOk} devvars=${devOk} wrangler=${wrOk} (want ${want})`);
  }
  (await exists(path.join(PROJECT_ROOT, '.dev.vars'))) ? pass('.dev.vars present') : fail('.dev.vars present', 'missing');
  const types = await fs.readFile(path.join(PROJECT_ROOT, 'worker-configuration.d.ts'), 'utf-8').catch(() => '');
  ['CHATWOOT_HOST', 'CHATWOOT_CONTACT_INBOX_IDENTIFIER', 'CHATWOOT_PRIVACY_INBOX_IDENTIFIER'].every((k) => types.includes(k))
    ? pass('worker types include all 3 vars') : fail('worker types include all 3 vars', 'run wrangler types');

  // worker files + form pages
  for (const f of [
    'src/lib/chatwoot-forms.ts', 'src/routes/api/contact.ts', 'src/routes/api/privacy.ts',
    'src/components/SupportForm.tsx', 'src/routes/contact.tsx', 'src/routes/privacy-request.tsx',
  ]) {
    (await exists(path.join(PROJECT_ROOT, f))) ? pass(`file ${f}`) : fail(`file ${f}`, 'missing');
  }

  // build + tsc
  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  build.status === 0 ? pass('npm run build') : fail('npm run build', (build.stderr || build.stdout || '').slice(-800));
  const tsc = spawnSync('npx', ['tsc', '--noEmit'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  tsc.status === 0 ? pass('tsc --noEmit') : fail('tsc --noEmit', (tsc.stderr || tsc.stdout || '').slice(-800));

  // live POST via vite dev
  const port = await pickFreePort();
  const vite = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/vite'), ['dev', '--port', String(port), '--host', '127.0.0.1'], { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' });
  try {
    if (!await waitHttp(`http://127.0.0.1:${port}/`)) { fail('vite dev boot', 'no 2xx within 60s'); }
    else {
      const post = async (route, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, json: await r.json().catch(() => ({})) };
      };
      // Assert each POST lands in the CORRECT inbox (fetch the created
      // conversation via the admin API and compare its inbox_id).
      const landsIn = async (route, body, expectName) => {
        const r = await post(route, body);
        if (!r.json.ok || !r.json.conversationId) return fail(`POST ${route} → conversation`, JSON.stringify(r.json).slice(0, 160));
        const conv = (await app(`/api/v1/accounts/${accountId}/conversations/${r.json.conversationId}`)).body;
        const wantInbox = real[expectName]?.id;
        String(conv.inbox_id) === String(wantInbox)
          ? pass(`POST ${route} → ${expectName}`, `conv #${r.json.conversationId} in inbox ${conv.inbox_id}`)
          : fail(`POST ${route} → ${expectName}`, `conv inbox_id ${conv.inbox_id} ≠ expected ${wantInbox}`);
      };
      await landsIn('/api/contact', { name: 'Verify Bot', email: 'verify-contact@example.com', message: 'skill 09 verify' }, 'Contact form');
      await landsIn('/api/privacy', { name: 'Verify Bot', email: 'verify-privacy@example.com', message: 'skill 09 verify' }, 'Privacy form');
      const h = await post('/api/contact', { name: 'Bot', email: 'bot@example.com', message: 'spam', company: 'AcmeBot' });
      h.json.ok && !h.json.conversationId ? pass('honeypot rejected silently', 'ok:true, no conversation') : fail('honeypot rejected silently', JSON.stringify(h.json).slice(0, 160));

      // Form PAGES render (GET 2xx + contain a form posting to the API).
      for (const [route, expect] of [['/contact', 'Get in touch'], ['/privacy-request', 'Privacy request']]) {
        const r = await fetch(`http://127.0.0.1:${port}${route}`);
        const html = r.ok ? await r.text() : '';
        r.ok && html.includes(expect) && /<form/i.test(html)
          ? pass(`page ${route} renders`, `HTTP ${r.status}`)
          : fail(`page ${route} renders`, `HTTP ${r.status}, form=${/<form/i.test(html)}, heading=${html.includes(expect)}`);
      }
    }
  } finally { if (vite.pid) await killGroup(vite.pid); }

  // per-inbox automation (ownerId resolved earlier)
  const rules = (await app(`/api/v1/accounts/${accountId}/automation_rules`)).body?.payload || [];
  for (const name of ['Contact form', 'Privacy form']) {
    const stub = inboxes.find((i) => i.name === name);
    const ok = stub && rules.some((r) => r.active && r.event_name === 'conversation_created' &&
      (r.conditions || []).some((c) => c.attribute_key === 'inbox_id' && (c.values || []).map(String).includes(String(stub.id))) &&
      (r.actions || []).some((a) => a.action_name === 'assign_agent' && (a.action_params || []).map(String).includes(String(ownerId))));
    ok ? pass(`auto-assign rule: ${name}`) : fail(`auto-assign rule: ${name}`, 'no active rule assigning this inbox to owner');
  }

  let okC = 0;
  for (const c of checks) { console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`); if (c.ok) okC++; }
  console.log(`\n${okC}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
