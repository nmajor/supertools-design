#!/usr/bin/env node
// 16-ralph-build setup.
// Guarded runner of the build-council loop → the live production domain. Enforces the
// approved plan + the generation keys, mirrors worker secrets into .dev.vars,
// then runs ralph-council.sh to completion. Long-running, real cost, live.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadEnv, requireEnv, writeEnvVar, PROJECT_ROOT } from '../_shared/env.mjs';
import { requireDomain } from '../_shared/project.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '16-ralph-build');
const AGENT = path.join(PROJECT_ROOT, '.agent');
const log = (...a) => console.log(...a);
const die = (m) => { console.error(`\n[build] BLOCKED: ${m}`); process.exit(1); };
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

// Non-destructive upsert of KEY=value into .dev.vars (gitignored worker secrets).
async function upsertDevVar(key, value) {
  const p = path.join(PROJECT_ROOT, '.dev.vars');
  let txt = await fs.readFile(p, 'utf-8').catch(() => '');
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(txt)) txt = txt.replace(re, line);
  else txt = (txt && !txt.endsWith('\n') ? txt + '\n' : txt) + line + '\n';
  await fs.writeFile(p, txt);
}

async function main() {
  loadEnv();
  await fs.mkdir(STATE_SUB, { recursive: true });

  // Preconditions.
  if (!await exists(path.join(PROJECT_ROOT, '.supertools-state', '14-ralph-harness.json'))) die('skill 14 (harness) not complete.');
  if (!await exists(path.join(PROJECT_ROOT, '.supertools-state', '15-ralph-plan.json'))) die('skill 15 (plan) not complete.');
  const driver = path.join(PROJECT_ROOT, 'scripts', 'ralph-local', 'ralph-council.sh');
  if (!await exists(driver)) die(`missing ${driver} — re-run skill 14.`);
  let status = 'unknown';
  try { status = JSON.parse(await fs.readFile(path.join(AGENT, 'planning-status.json'), 'utf-8')).status; } catch {}
  if (status !== 'approved') die(`planning-status is '${status}', not 'approved' — run skill 15 first.`);

  // The generation keys (match the PoC's providers: OpenAI + fal.ai).
  requireEnv(['FAL_API_KEY', 'OPENAI_API_KEY']);

  // Better Auth secret — generate once if absent.
  if (!process.env.BETTER_AUTH_SECRET) {
    const secret = crypto.randomBytes(32).toString('base64');
    await writeEnvVar('BETTER_AUTH_SECRET', secret);
    process.env.BETTER_AUTH_SECRET = secret;
    log('[build] generated BETTER_AUTH_SECRET');
  }

  // Mirror the new secrets into .dev.vars so the Worker sees them locally during
  // the loop's verification. TASK-1 wires the remaining secrets + bindings.
  for (const k of ['FAL_API_KEY', 'OPENAI_API_KEY', 'BETTER_AUTH_SECRET']) await upsertDevVar(k, process.env[k]);
  log('[build] mirrored FAL_API_KEY + OPENAI_API_KEY + BETTER_AUTH_SECRET into .dev.vars');

  const total = JSON.parse(await fs.readFile(path.join(AGENT, 'tasks.json'), 'utf-8')).length;
  log(`[build] running build-council over ${total} tasks → live ${requireDomain()}. This is long (hours).`);
  const r = spawnSync('bash', [driver], { cwd: PROJECT_ROOT, stdio: 'inherit', env: process.env });

  // Outcome.
  const tasks = JSON.parse(await fs.readFile(path.join(AGENT, 'tasks.json'), 'utf-8'));
  const passed = tasks.filter((t) => t.passes === true).length;
  const summary = {
    driverExit: r.status,
    tasksPassed: passed, tasksTotal: tasks.length,
    // COMPLETE requires BOTH a clean driver exit AND all tasks passed — never
    // trust stale task state if the harness itself exited non-zero.
    complete: passed === tasks.length && r.status === 0,
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(STATE_SUB, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  if (!summary.complete) {
    console.error(`\n[build] incomplete: ${passed}/${tasks.length} tasks passed (driver exit ${r.status}). See .agent/logs/LOG.md + .agent/reviews/. Re-run to resume.`);
    process.exit(1);
  }
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
