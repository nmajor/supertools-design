#!/usr/bin/env node
// 14-ralph-harness setup.
// Vendor PageAI-Pro/ralph-loop, lay the de-dockerized 3-agent council engine
// under scripts/ralph-local/ + the .agent/ workspace, install Playwright, and
// best-effort push the generic engine to supertools-stack. Idempotent; never
// clobbers an approved plan or a non-empty tasks.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';
import { ensureRepo, tryPushChanges } from '../_shared/repos.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(SKILL_DIR, 'templates');
const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '14-ralph-harness');
const RALPH_LOCAL = path.join(PROJECT_ROOT, 'scripts', 'ralph-local');
const AGENT = path.join(PROJECT_ROOT, '.agent');

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const copy = async (from, to) => { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to); };

async function main() {
  loadEnv();
  await fs.mkdir(STATE_SUB, { recursive: true });

  // 1) Vendor ralph-loop (reference + the pure promise.sh we reuse verbatim).
  log('[vendor] ensuring ralph-loop…');
  const ralph = await ensureRepo('ralph-loop');
  const promiseSrc = path.join(ralph.path, 'scripts', 'lib', 'promise.sh');
  if (!await exists(promiseSrc)) die(`ralph-loop missing scripts/lib/promise.sh @ ${ralph.sha}`);

  // 2) .agent/ workspace skeleton.
  for (const d of ['prd', 'tasks', 'logs', 'history', 'screenshots', 'reviews', 'council']) {
    await fs.mkdir(path.join(AGENT, d), { recursive: true });
  }

  // 3) Engine: drivers + lib (+ vendored promise.sh).
  await fs.mkdir(path.join(RALPH_LOCAL, 'lib'), { recursive: true });
  for (const f of ['ralph-plan-council.sh', 'ralph-council.sh']) {
    await copy(path.join(TPL, 'ralph-local', f), path.join(RALPH_LOCAL, f));
    await fs.chmod(path.join(RALPH_LOCAL, f), 0o755);
  }
  for (const f of ['common.sh', 'agents-local.sh', 'task-state.sh']) {
    await copy(path.join(TPL, 'ralph-local', 'lib', f), path.join(RALPH_LOCAL, 'lib', f));
  }
  await copy(promiseSrc, path.join(RALPH_LOCAL, 'lib', 'promise.sh'));
  log('[engine] scripts/ralph-local/ laid (drivers + lib + vendored promise.sh)');

  // 4) Council prompts.
  const councilFiles = ['PLAN_GENERATOR.md', 'PLAN_REVIEWER.md', 'BUILD_TASK.md',
    'CODE_REVIEWER.md', 'INTEGRATION_REVIEWER.md', 'FIX_REVIEW.md'];
  for (const f of councilFiles) await copy(path.join(TPL, 'council', f), path.join(AGENT, 'council', f));
  // BUILD_TASK is the per-iteration build prompt (ralph convention = .agent/PROMPT.md).
  await copy(path.join(TPL, 'council', 'BUILD_TASK.md'), path.join(AGENT, 'PROMPT.md'));
  log('[council] 6 prompts + .agent/PROMPT.md written');

  // 5) DECISIONS + STEERING (always refreshed — they're authored, not stateful).
  // DECISIONS.md is AUTHORED, not generated: scaffold it from the template on
  // first run, then never clobber the project's answers on a re-run.
  const decisionsPath = path.join(AGENT, 'DECISIONS.md');
  if (await exists(decisionsPath)) {
    log('  .agent/DECISIONS.md already exists — left untouched');
  } else {
    const tpl = await fs.readFile(path.join(TPL, 'DECISIONS.template.md'), 'utf-8');
    await fs.writeFile(decisionsPath, tpl.replaceAll('__BRAND_NAME__', readProject().brandName));
    log('  scaffolded .agent/DECISIONS.md from template — FILL IT IN before skill 15');
  }
  await copy(path.join(TPL, 'STEERING.md'), path.join(AGENT, 'STEERING.md'));

  // 6) planning-status + tasks.json — PRESERVE an approved plan / non-empty tasks.
  const psPath = path.join(AGENT, 'planning-status.json');
  let preservedPlan = false;
  if (await exists(psPath)) {
    const cur = JSON.parse(await fs.readFile(psPath, 'utf-8').catch(() => '{}'));
    if (cur.status === 'approved') { preservedPlan = true; log('[plan] existing approved planning-status preserved'); }
  }
  if (!preservedPlan) await copy(path.join(TPL, 'planning-status.json'), psPath);

  const tasksPath = path.join(AGENT, 'tasks.json');
  let preservedTasks = false;
  if (await exists(tasksPath)) {
    const arr = JSON.parse(await fs.readFile(tasksPath, 'utf-8').catch(() => '[]'));
    if (Array.isArray(arr) && arr.length > 0) { preservedTasks = true; log(`[plan] existing tasks.json preserved (${arr.length} tasks)`); }
  }
  if (!preservedTasks) await fs.writeFile(tasksPath, '[]\n');

  // 7) Playwright for local UI verification (skill 16). Best-effort chromium.
  log('[playwright] installing @playwright/test (devDependency)…');
  const pwInstall = spawnSync('npm', ['install', '--save-dev', '--no-audit', '--no-fund', '@playwright/test'],
    { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  const playwrightDep = pwInstall.status === 0;
  if (!playwrightDep) log(`[playwright] npm install warn: ${(pwInstall.stderr || '').slice(-200)}`);
  let chromium = false;
  if (playwrightDep) {
    const cr = spawnSync('npx', ['playwright', 'install', 'chromium'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    chromium = cr.status === 0;
    log(chromium ? '[playwright] chromium installed' : `[playwright] chromium install deferred (will retry in build): ${(cr.stderr || '').slice(-160)}`);
  }

  // 8) Best-effort push the GENERIC engine to supertools-stack (not DECISIONS.md).
  let push = { attempted: false };
  try {
    const stack = await ensureRepo('supertools-stack');
    const dest = path.join(stack.path, 'ralph-harness');
    await fs.mkdir(path.join(dest, 'ralph-local', 'lib'), { recursive: true });
    await fs.mkdir(path.join(dest, 'council'), { recursive: true });
    for (const f of ['ralph-plan-council.sh', 'ralph-council.sh'])
      await copy(path.join(RALPH_LOCAL, f), path.join(dest, 'ralph-local', f));
    for (const f of ['common.sh', 'agents-local.sh', 'task-state.sh', 'promise.sh'])
      await copy(path.join(RALPH_LOCAL, 'lib', f), path.join(dest, 'ralph-local', 'lib', f));
    for (const f of councilFiles) await copy(path.join(AGENT, 'council', f), path.join(dest, 'council', f));
    push = { attempted: true, ...tryPushChanges(stack.path, 'feat(ralph-harness): de-dockerized 3-agent council engine') };
  } catch (e) { push = { attempted: true, note: `skipped: ${e.message.slice(0, 160)}` }; }

  const summary = {
    ralphLoopSha: ralph.sha,
    engine: 'scripts/ralph-local/{ralph-plan-council.sh,ralph-council.sh,lib/*}',
    agentWorkspace: '.agent/{PROMPT.md,DECISIONS.md,STEERING.md,planning-status.json,council/*,prd/,tasks/,logs/,history/,screenshots/,reviews/}',
    councilPrompts: councilFiles,
    planPreserved: preservedPlan, tasksPreserved: preservedTasks,
    playwright: { dep: playwrightDep, chromium },
    supertoolsPush: push,
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(STATE_SUB, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
