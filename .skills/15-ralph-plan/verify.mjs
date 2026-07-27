#!/usr/bin/env node
// 15-ralph-plan verifier — independent coverage audit of the council-approved
// plan (backstop to the 3-agent gate). Does NOT re-run the council.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from '../_shared/env.mjs';

const AGENT = path.join(PROJECT_ROOT, '.agent');
const checks = [];
const pass = (n, d = '') => checks.push({ n, ok: true, d });
const fail = (n, d = '') => checks.push({ n, ok: false, d });
const readJson = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } };

async function main() {
  // 1) planning-status approved
  const ps = await readJson(path.join(AGENT, 'planning-status.json'));
  (ps && ps.status === 'approved') ? pass('planning-status = approved') : fail('planning-status = approved', `status=${ps?.status}`);

  // 2) tasks.json schema + non-empty
  const tasks = await readJson(path.join(AGENT, 'tasks.json'));
  if (!Array.isArray(tasks) || tasks.length === 0) {
    fail('tasks.json non-empty array', `got ${tasks === null ? 'unreadable' : typeof tasks}`);
    return report();
  }
  pass('tasks.json non-empty array', `${tasks.length} tasks`);

  const idsOk = tasks.every((t) => t.id && t.title && typeof t.priority === 'number' && t.specFilePath && 'passes' in t);
  idsOk ? pass('task summaries well-formed') : fail('task summaries well-formed', 'a task is missing id/title/priority/specFilePath/passes');
  const anyPassed = tasks.filter((t) => t.passes === true).length;
  anyPassed === 0 ? pass('all tasks start passes:false') : fail('all tasks start passes:false', `${anyPassed} already passes:true (re-run after build?)`);

  // 3) each spec file exists + has acceptance/tests/integration
  let blob = '';
  let specsOk = 0, specsBad = [];
  for (const t of tasks) {
    const spec = await readJson(path.join(PROJECT_ROOT, t.specFilePath));
    if (!spec) { specsBad.push(`${t.id}:missing-spec`); continue; }
    const okAC = Array.isArray(spec.acceptanceCriteria) && spec.acceptanceCriteria.length > 0;
    const okT = Array.isArray(spec.tests) && spec.tests.length > 0;
    const okI = Array.isArray(spec.integration) && spec.integration.length > 0;
    if (okAC && okT && okI) specsOk++; else specsBad.push(`${t.id}:${!okAC ? 'AC ' : ''}${!okT ? 'tests ' : ''}${!okI ? 'integration' : ''}`.trim());
    blob += ' ' + JSON.stringify(spec).toLowerCase() + ' ' + (t.title + ' ' + (t.area || '')).toLowerCase();
  }
  specsBad.length === 0
    ? pass('every task spec has acceptance+tests+integration', `${specsOk}/${tasks.length}`)
    : fail('every task spec has acceptance+tests+integration', `${specsBad.length} bad: ${specsBad.slice(0, 8).join('; ')}`);

  // 4) TASK-1 is prereqs/access
  const t1 = tasks.find((t) => t.id === 'TASK-1');
  const t1spec = t1 ? await readJson(path.join(PROJECT_ROOT, t1.specFilePath)) : null;
  const t1text = (JSON.stringify(t1spec || {}) + ' ' + (t1?.title || '')).toLowerCase();
  (t1 && /(prereq|prerequisite|access|binding|credential|d1|r2|kv|queue|migrat)/.test(t1text))
    ? pass('TASK-1 is prereqs/access/bindings') : fail('TASK-1 is prereqs/access', `TASK-1=${t1?.title}`);

  // 5) coverage of sections + shell
  const sections = {
    landing: /landing|hero|home ?page|example gallery/, quiz: /quiz/, directions: /direction/,
    pack: /\bpack\b|your pack|6 (artifact|pin)|moodboard/, boards: /\bboards\b|my boards|dashboard/,
    shell: /shell|app ?shell|nav\b|footer|wordmark/,
  };
  for (const [k, re] of Object.entries(sections)) re.test(blob) ? pass(`covers section: ${k}`) : fail(`covers section: ${k}`, 'no task mentions it');

  // 6) coverage of the 8 ralph-requirements themes
  const reqs = {
    'naked→www redirect': /naked|www[- ]?redirect|apex|301/, 'transactional email': /transactional|ahasend|email (envelope|send)/,
    'chat widget': /chatwoot|chat widget/, 'contact/privacy forms': /contact|privacy[- ]request|support form/,
    'polar checkout': /checkout|polar/, 'polar webhook': /webhook/, 'cron heartbeat': /cron|heartbeat|scheduled\(/,
    'poc resource-gen': /\bfal\b|flux|tile|render|generate.*(pack|artifact)/,
  };
  for (const [k, re] of Object.entries(reqs)) re.test(blob) ? pass(`covers requirement: ${k}`) : fail(`covers requirement: ${k}`, 'no task mentions it');

  // 7) resource-gen broken into a real sub-epic (≥4 tasks)
  const genTasks = tasks.filter((t) => {
    const txt = (t.title + ' ' + (t.area || '')).toLowerCase();
    return /fal|flux|tile|render|moodboard|pack|style ?direction|browser rendering|r2|queue/.test(txt);
  }).length;
  genTasks >= 4 ? pass('resource-gen is a multi-task sub-epic', `${genTasks} tasks`) : fail('resource-gen sub-epic ≥4 tasks', `only ${genTasks}`);

  // 8) auth + deploy/cutover present
  /better ?auth|magic ?link|\bsession\b|sign ?in|login/.test(blob) ? pass('covers auth (Better Auth)') : fail('covers auth', 'no auth task');
  /wrangler deploy|custom domain|cutover|secret put|go ?live|deploy.*(live|production)/.test(blob)
    ? pass('covers live deploy + cutover') : fail('covers live deploy + cutover', 'no deploy task');

  // 9) the 3 approval reviews are archived
  let reviews = [];
  try { reviews = await fs.readdir(path.join(AGENT, 'reviews')); } catch {}
  const hasR = (who) => reviews.some((f) => new RegExp(`PLAN-.*${who}`, 'i').test(f));
  (hasR('claude') && hasR('codex') && hasR('gemini'))
    ? pass('3-agent plan reviews archived') : fail('3-agent plan reviews archived', `reviews: ${reviews.join(',').slice(0, 120)}`);

  // Print the plan for human review.
  console.log('\n=== APPROVED PLAN (' + tasks.length + ' tasks, by priority) ===');
  for (const t of [...tasks].sort((a, b) => (b.priority || 0) - (a.priority || 0)))
    console.log(`  [${String(t.priority).padStart(3)}] ${t.id.padEnd(9)} ${(t.area || t.type || '').padEnd(12)} ${t.title}`);
  console.log('');

  report();
}

function report() {
  let ok = 0;
  for (const c of checks) { console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.n}${c.d ? ' — ' + c.d : ''}`); if (c.ok) ok++; }
  console.log(`\n${ok}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
