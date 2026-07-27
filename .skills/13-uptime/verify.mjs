#!/usr/bin/env node
// 13-uptime verifier.
// Confirms the paused dead-man check, secret-class handling of the ping URL
// (in .env; NOT in wrangler.jsonc or any tracked file), the /api/health
// route live under vite dev, and build/typecheck health.
// Every check name/detail passes through the shared redactor — the ping URL
// is a spoof capability and must never appear in artifacts.

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';
import { buildRedactor } from '../_shared/redact.mjs';
import requires from './requires.json' with { type: 'json' };

const CHECK_NAME = `${readProject().projectName}-prod-heartbeat`;
let redact = (s) => s; // rebuilt after loadEnv so .env values are covered

const checks = [];
const fail = (n, d = '') => { checks.push({ name: redact(n), ok: false, detail: redact(d) }); };
const pass = (n, d = '') => { checks.push({ name: redact(n), ok: true, detail: redact(d) }); };

function hcBase() { return (process.env.HEALTHCHECK_HOST || '').replace(/\/+$/, ''); }
async function hc(p, init = {}) {
  const r = await fetch(`${hcBase()}${p}`, { ...init, headers: { 'X-Api-Key': process.env.HEALTHCHECK_API_KEY, ...(init.headers || {}) } });
  const t = await r.text(); let b; try { b = t ? JSON.parse(t) : {}; } catch { b = t; }
  return { ok: r.ok, status: r.status, body: b };
}
function pickFreePort() { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); }); }
async function waitHttp(url, ms = 60000) { const start = Date.now(); while (Date.now() - start < ms) { try { const r = await fetch(url); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 500)); } return false; }
async function killGroup(pid) { try { process.kill(-pid, 'SIGTERM'); } catch {} await new Promise((r) => setTimeout(r, 500)); try { process.kill(-pid, 'SIGKILL'); } catch {} }
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

async function main() {
  loadEnv();
  redact = buildRedactor([...requires.envRequired, 'HEALTHCHECK_PING_URL'], ['HEALTHCHECK_CHECK_SLUG']).redact;
  requireEnv(['HEALTHCHECK_API_KEY', 'HEALTHCHECK_HOST', 'HEALTHCHECK_PING_URL']);

  // Check exists, paused, configured, channel attached.
  const list = await hc('/api/v3/checks/');
  const check = (list.body.checks || []).find((c) => c.name === CHECK_NAME);
  check ? pass('HC check exists', CHECK_NAME) : fail('HC check exists', 'not found');
  if (check) {
    check.ping_url === process.env.HEALTHCHECK_PING_URL
      ? pass('ping_url matches persisted .env value')
      : fail('ping_url matches persisted .env value', 'mismatch (values withheld — re-run setup to re-persist)');
    (check.channels && check.channels.trim() !== '')
      ? pass('notification channel attached')
      : fail('notification channel attached', 'channels empty — down state would notify nobody');
    (Number(check.timeout) === 3600 && Number(check.grace) === 3600)
      ? pass('timeout/grace = 3600/3600') : fail('timeout/grace = 3600/3600', `timeout=${check.timeout} grace=${check.grace}`);
    check.slug === CHECK_NAME ? pass('slug matches') : fail('slug matches', `slug=${check.slug}`);
    // manual_resume must be OFF or a paused check ignores pings forever and
    // "first production ping arms it" silently breaks.
    check.manual_resume === false
      ? pass('manual_resume=false (pings auto-resume)')
      : fail('manual_resume=false (pings auto-resume)', `manual_resume=${check.manual_resume}`);
    // Pre-deploy the check must be paused; once production pings, up/grace
    // are the healthy states. Only "new" (unpaused, never pinged) is wrong —
    // setup should have paused it.
    // Only 'new' is wrong (setup should have paused it). Everything else is
    // a legitimate lifecycle state — including 'down' during a production
    // outage, when blocking a re-run would be exactly backwards.
    check.status !== 'new'
      ? pass('check state sane (anything but new)', `status=${check.status}`)
      : fail('check state sane (anything but new)', 'status=new — setup should have paused a never-pinged check; re-run setup');
  }

  // Secret-class handling: in .env, and NOWHERE in tracked config/source.
  const env = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf-8').catch(() => '');
  /^HEALTHCHECK_PING_URL=https?:\/\//m.test(env) ? pass('HEALTHCHECK_PING_URL in .env') : fail('HEALTHCHECK_PING_URL in .env', 'missing');
  /^HEALTHCHECK_CHECK_SLUG=/m.test(env) ? pass('HEALTHCHECK_CHECK_SLUG in .env') : fail('HEALTHCHECK_CHECK_SLUG in .env', 'missing');
  // Leak scan. Two signals, filenames-only reporting:
  //   (a) the CURRENT ping UUID anywhere — the live capability must not leak;
  //   (b) the ping HOST followed by a UUID-shaped path segment — catches
  //       rotated-away STALE URLs on any Healthchecks URL shape (self-hosted
  //       /ping/<uuid>, hc-ping.com/<uuid>, …) without false-positiving on
  //       documentation that merely names the host (e.g. this SKILL.md).
  // Scope: every git-tracked file + this skill's state dir, RECURSIVELY
  // (council/collab artifacts live in nested subdirectories).
  {
    const pingHost = new URL(process.env.HEALTHCHECK_PING_URL).host;
    const uuid = (process.env.HEALTHCHECK_PING_URL || '').split('/').pop();
    const escaped = pingHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const staleRe = new RegExp(escaped + '[^\\s"\']*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}');
    // --cached + --others: tracked AND untracked (e.g. skill files, generated
    // routes, the candidate receipt) — standard excludes keep node_modules out.
    const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: PROJECT_ROOT, encoding: 'utf-8' })
      .stdout.split('\n').filter(Boolean);
    async function walk(rel) {
      const abs = path.join(PROJECT_ROOT, rel);
      const st = await fs.lstat(abs).catch(() => null);
      if (!st) return [];
      if (st.isFile()) return [rel];
      if (!st.isDirectory()) return [];
      const out = [];
      for (const e of await fs.readdir(abs).catch(() => [])) out.push(...await walk(path.join(rel, e)));
      return out;
    }
    const stateFiles = await walk('.supertools-state'); // whole state tree incl. candidate receipts + other skills
    const leaks = [];
    let scanned = 0;
    for (const f of [...tracked, ...stateFiles]) {
      const abs = path.join(PROJECT_ROOT, f);
      const st = await fs.lstat(abs).catch(() => null);
      if (!st || !st.isFile()) continue;
      const text = await fs.readFile(abs, 'utf-8').catch(() => '');
      scanned++;
      if ((uuid && text.includes(uuid)) || staleRe.test(text)) leaks.push(f);
    }
    leaks.length === 0
      ? pass(`no ping-endpoint leak (${scanned} files: tracked + state dir recursive)`)
      : fail('no ping-endpoint leak', `found in (filenames only): ${leaks.join(', ')}`);
  }

  // Health route present.
  (await exists(path.join(PROJECT_ROOT, 'src/routes/api/health.ts'))) ? pass('file src/routes/api/health.ts') : fail('file src/routes/api/health.ts', 'missing');

  // Ralph requirement recorded with the secret posture.
  try {
    const reqs = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'ralph-requirements.json'), 'utf-8'));
    const req = reqs.find((r) => r.skillId === '13-uptime' && r.key === 'cron-heartbeat');
    (req && /secret put/i.test(req.requirement))
      ? pass('cron-heartbeat requirement recorded (secret-binding posture)')
      : fail('cron-heartbeat requirement recorded (secret-binding posture)', 'missing or lacks the wrangler-secret posture');
  } catch (e) {
    fail('cron-heartbeat requirement recorded', `ralph-requirements.json unreadable: ${e.message}`);
  }

  // Build + typecheck.
  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 });
  build.status === 0 ? pass('npm run build') : fail('npm run build', (build.stderr || build.stdout || '').slice(-800));
  const tsc = spawnSync('npx', ['tsc', '--noEmit'], { cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 });
  tsc.status === 0 ? pass('tsc --noEmit') : fail('tsc --noEmit', (tsc.stderr || tsc.stdout || '').slice(-800));

  // /api/health returns {ok:true} under vite dev.
  const port = await pickFreePort();
  const vite = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/vite'), ['dev', '--port', String(port), '--host', '127.0.0.1'], { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' });
  try {
    if (!await waitHttp(`http://127.0.0.1:${port}/api/health`)) { fail('GET /api/health', 'vite dev did not serve /api/health within 60s'); }
    else {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      const j = await r.json().catch(() => ({}));
      r.ok && j.ok === true ? pass('GET /api/health → {ok:true}', `HTTP ${r.status}`) : fail('GET /api/health → {ok:true}', `HTTP ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
    }
  } finally { if (vite.pid) await killGroup(vite.pid); }

  let okC = 0;
  for (const c of checks) { console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`); if (c.ok) okC++; }
  console.log(`\n${okC}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(redact(e.stack || e.message)); process.exit(2); });
