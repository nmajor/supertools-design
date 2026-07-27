#!/usr/bin/env node
// 13-uptime setup.
// Ensures the Healthchecks dead-man's-switch check exists, persists its ping
// URL to .env ONLY (the ping URL is a spoof capability — never logged, never
// in wrangler.jsonc, never in receipts), lays down /api/health, and leaves
// the check PAUSED so no countdown is armed before production pings exist
// (Healthchecks auto-resumes a paused check on its next real ping).
//
// Flags/env:
//   ROTATE_HEARTBEAT=1  — delete the existing check first (new ping UUID);
//                         used when a ping URL has been exposed.
// Idempotent otherwise (unique-by-name ensure; pause is re-run-safe).

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, requireEnv, writeEnvVar, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';
import { appendRalphRequirement } from '../_shared/state.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '13-uptime');
const CHECK_NAME = `${readProject().projectName}-prod-heartbeat`;

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

function hcBase() { return (process.env.HEALTHCHECK_HOST || '').replace(/\/+$/, ''); }
async function hc(p, init = {}) {
  const r = await fetch(`${hcBase()}${p}`, {
    ...init,
    headers: { 'X-Api-Key': process.env.HEALTHCHECK_API_KEY, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const t = await r.text(); let b; try { b = t ? JSON.parse(t) : {}; } catch { b = t; }
  return { ok: r.ok, status: r.status, body: b };
}

// The check's UUID (and thus its ping URL) is the spoofing capability —
// derive the API resource path without ever printing it.
const uuidOf = (check) => (check.ping_url || '').split('/').pop();

async function findCheck() {
  const list = await hc('/api/v3/checks/');
  if (!list.ok) die(`HC list checks failed (${list.status})`);
  return (list.body.checks || []).find((c) => c.name === CHECK_NAME) || null;
}

async function main() {
  loadEnv();
  requireEnv(['HEALTHCHECK_API_KEY', 'HEALTHCHECK_HOST']);
  await fs.mkdir(STATE_SUB, { recursive: true });

  if (process.env.ROTATE_HEARTBEAT === '1') {
    const existing = await findCheck();
    if (existing) {
      const del = await hc(`/api/v3/checks/${uuidOf(existing)}`, { method: 'DELETE' });
      if (!del.ok) die(`HC delete for rotation failed (${del.status})`);
      log(`[hc] ROTATE_HEARTBEAT: deleted existing check "${CHECK_NAME}" (ping UUID rotated)`);
    } else {
      log('[hc] ROTATE_HEARTBEAT: no existing check to delete');
    }
  }

  // Idempotent ensure (unique by name). channels:"*" attaches all
  // notification channels (override with HEALTHCHECK_CHANNELS) — without a
  // channel the check would go down silently and notify nobody.
  const channels = process.env.HEALTHCHECK_CHANNELS || '*';
  log(`[hc] ensuring check "${CHECK_NAME}" (channels=${channels})...`);
  const r = await hc('/api/v3/checks/', {
    method: 'POST',
    // manual_resume:false is load-bearing: with it true, a paused check would
    // ignore pings forever and the "first production ping arms it" guarantee
    // silently breaks.
    body: JSON.stringify({ name: CHECK_NAME, slug: CHECK_NAME, tags: `${readProject().projectName} prod`, timeout: 3600, grace: 3600, channels, manual_resume: false, unique: ['name'] }),
  });
  if (!r.ok || !r.body.ping_url) die(`HC create/ensure check failed (${r.status})`);
  if (!r.body.channels) die('HC check has no notification channels attached — it would alert nobody. Configure a channel in Healthchecks (or set HEALTHCHECK_CHANNELS), then re-run.');
  const pingUrl = r.body.ping_url;
  const slug = r.body.slug || CHECK_NAME;
  const created = r.status === 201;
  log(`[hc] check ready (created=${created}; ping URL captured — redacted, persisted to .env only)`);

  // PAUSE only a never-pinged check ("new") so the dead-man countdown is not
  // armed before the deploy-time cron exists. A check that is already live
  // (up/grace — production is pinging) must NEVER be paused by a re-run:
  // that would silence real alerting. Already-paused is a no-op.
  const status = r.body.status;
  if (status === 'new') {
    const pause = await hc(`/api/v3/checks/${uuidOf(r.body)}/pause`, { method: 'POST' });
    if (!pause.ok) die(`HC pause failed (${pause.status}) — a new unpaused check would false-alarm after its first ping stops.`);
    log('[hc] new check paused — armed automatically by the first production ping (manual_resume=false)');
  } else if (status === 'paused') {
    log('[hc] check already paused — no-op');
  } else {
    log(`[hc] check is live (status=${status}) — leaving it armed; re-runs never silence production`);
  }

  // Ping URL is secret-class: .env now; a Worker secret at deploy time.
  await writeEnvVar('HEALTHCHECK_PING_URL', pingUrl);
  await writeEnvVar('HEALTHCHECK_CHECK_SLUG', slug);
  log('[env] HEALTHCHECK_PING_URL + HEALTHCHECK_CHECK_SLUG persisted to .env');

  // Health route (self-contained liveness endpoint).
  const routeDir = path.join(PROJECT_ROOT, 'src', 'routes', 'api');
  await fs.mkdir(routeDir, { recursive: true });
  const healthTpl = await fs.readFile(
    path.join(PROJECT_ROOT, '.skills', '13-uptime', 'templates', 'health.ts'), 'utf-8');
  await fs.writeFile(
    path.join(routeDir, 'health.ts'),
    healthTpl.replaceAll('__PROJECT_NAME__', readProject().projectName));
  log('[worker] wrote src/routes/api/health.ts');

  await appendRalphRequirement('13-uptime', 'cron-heartbeat',
    'Add a CF Cron Trigger (wrangler.jsonc "triggers": { "crons": ["0 * * * *"] }) and a Worker scheduled() ' +
    'handler that GETs the HEALTHCHECK_PING_URL SECRET. The ping URL is a spoof capability: provision it with ' +
    '`wrangler secret put HEALTHCHECK_PING_URL` (value from .env) at deploy — NEVER as a plaintext wrangler.jsonc var. ' +
    `The Healthchecks check (${CHECK_NAME}) exists and is PAUSED; the first production ping auto-resumes/arms it. ` +
    'Ship the cron trigger, the scheduled() handler, and the secret together so there is no dangling piece.');
  log('[ralph] cron-heartbeat requirement recorded (secret-binding posture)');

  const summary = {
    checkName: CHECK_NAME,
    slug,
    created,
    state: status === 'new' ? 'paused (was new; armed by first production ping)' : status,
    pingUrl: 'persisted to .env as HEALTHCHECK_PING_URL (redacted here — spoof capability)',
    healthRoute: 'src/routes/api/health.ts (GET → { ok, service, ts })',
    envWritten: ['HEALTHCHECK_PING_URL', 'HEALTHCHECK_CHECK_SLUG'],
    workerSecretAtDeploy: 'HEALTHCHECK_PING_URL via wrangler secret put (ralph requirement cron-heartbeat)',
    completedAt: new Date().toISOString(),
  };
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
