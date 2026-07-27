#!/usr/bin/env node
// 15-ralph-plan setup.
// Prepare the source bundle and drive the harness plan-council to generate +
// unanimously approve the canonical task plan. Long-running (real claude/codex/
// gemini). On approval writes planning-status.json=approved.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '15-ralph-plan');
const AGENT = path.join(PROJECT_ROOT, '.agent');
const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

// Out-of-repo / extra sources the generator must read, appended to the driver's
// project-relative defaults.
//
// PLAN_POC_DIR is an OPTIONAL absolute path to a proof-of-concept the plan
// council should read (the reference implementation pointed at a local PoC that
// the resource-generation tasks were ported from). Unset = skipped, which is
// the normal case for a fresh project.
const POC_DIR = process.env.PLAN_POC_DIR || null;

const PLAN_SOURCES = [
  '# Extra plan sources (one per line; # = comment). Appended to the driver defaults.',
  ...(POC_DIR ? [POC_DIR] : []),
  'design/product-plan/sections',
  'design/product-plan/design-system',
  'design/product-plan/data-shapes',
];

async function main() {
  loadEnv();
  await fs.mkdir(STATE_SUB, { recursive: true });

  // Preconditions: engine + workspace present.
  if (!await exists(path.join(PROJECT_ROOT, '.supertools-state', '14-ralph-harness.json')))
    die('skill 14 (ralph-harness) has not completed — run it first.');
  const driver = path.join(PROJECT_ROOT, 'scripts', 'ralph-local', 'ralph-plan-council.sh');
  if (!await exists(driver)) die(`missing ${driver} — re-run skill 14 setup.`);
  if (!await exists(path.join(AGENT, 'planning-status.json'))) die('missing .agent/planning-status.json — re-run skill 14 setup.');
  if (!await exists(path.join(AGENT, 'DECISIONS.md'))) die('missing .agent/DECISIONS.md — re-run skill 14 setup.');
  // The template ships with an UNFILLED marker; planning on an unfilled
  // decisions file produces a plan for nobody's product.
  if ((await fs.readFile(path.join(AGENT, 'DECISIONS.md'), 'utf-8')).includes('> **UNFILLED**'))
    die('.agent/DECISIONS.md still carries the UNFILLED marker — fill it in and delete that line before planning.');

  // Sanity: if a PoC was requested, it must actually exist.
  if (POC_DIR && !await exists(POC_DIR))
    die(`PLAN_POC_DIR is set to ${POC_DIR} but that path does not exist.`);

  await fs.writeFile(path.join(AGENT, 'plan-sources.txt'), PLAN_SOURCES.join('\n') + '\n');
  log('[plan] wrote .agent/plan-sources.txt');

  log('[plan] running plan-council (generate → unanimous 3-agent review). This is long…');
  // 5 rounds: round 0 generates; rounds 1–4 patch the plan in place against the
  // council's findings so fixes accumulate toward unanimous approval.
  const env = { ...process.env, MAX_PLAN_ROUNDS: process.env.MAX_PLAN_ROUNDS || '5' };
  const r = spawnSync('bash', [driver], { cwd: PROJECT_ROOT, stdio: 'inherit', env });

  // Evaluate outcome from planning-status (authoritative).
  let status = 'unknown';
  try { status = JSON.parse(await fs.readFile(path.join(AGENT, 'planning-status.json'), 'utf-8')).status; } catch {}
  let taskCount = 0;
  try { const t = JSON.parse(await fs.readFile(path.join(AGENT, 'tasks.json'), 'utf-8')); taskCount = Array.isArray(t) ? t.length : 0; } catch {}

  const summary = {
    driverExit: r.status,
    planningStatus: status,
    taskCount,
    planSources: PLAN_SOURCES.filter((l) => !l.startsWith('#')),
    reviewsDir: '.agent/reviews/',
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(STATE_SUB, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  if (status !== 'approved') {
    console.error(`\n[plan] NOT approved (status=${status}, driver exit=${r.status}). See .agent/reviews/ for blocking findings.`);
    process.exit(1);
  }
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
