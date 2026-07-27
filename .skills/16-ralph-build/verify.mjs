#!/usr/bin/env node
// 16-ralph-build verifier — asserts the build loop completed and the app is
// live. Run after setup.mjs finishes (the loop reached COMPLETE + deployed).

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { requireDomain } from '../_shared/project.mjs';

const AGENT = path.join(PROJECT_ROOT, '.agent');
const checks = [];
const pass = (n, d = '') => checks.push({ n, ok: true, d });
const fail = (n, d = '') => checks.push({ n, ok: false, d });
const DOMAIN = requireDomain();

async function main() {
  loadEnv();

  // 0) the harness actually reported COMPLETE with a clean driver exit
  const summary = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', '16-ralph-build', 'summary.json'), 'utf-8').catch(() => '{}'));
  (summary.complete === true) ? pass('summary.complete === true') : fail('summary.complete === true', JSON.stringify(summary).slice(0, 120));
  (summary.driverExit === 0) ? pass('driver exit === 0') : fail('driver exit === 0', `driverExit=${summary.driverExit}`);
  const slog = await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', '16-ralph-build', 'setup-output.log'), 'utf-8').catch(() => '');
  /<promise>COMPLETE<\/promise>/.test(slog) ? pass('COMPLETE promise in setup log') : fail('COMPLETE promise in setup log', 'not found');
  const branch = spawnSync('git', ['-C', PROJECT_ROOT, 'branch', '--show-current'], { encoding: 'utf-8' }).stdout.trim();
  (branch === 'ralph/build') ? pass('on ralph/build branch') : fail('on ralph/build branch', `on ${branch}`);

  // 1) all tasks passed
  const tasks = JSON.parse(await fs.readFile(path.join(AGENT, 'tasks.json'), 'utf-8').catch(() => '[]'));
  const passed = tasks.filter((t) => t.passes === true).length;
  (tasks.length > 0 && passed === tasks.length)
    ? pass('all tasks passes:true', `${passed}/${tasks.length}`)
    : fail('all tasks passes:true', `${passed}/${tasks.length}`);

  // 2) EXACT per-task commit coverage: every task id has a feat(<id>) commit
  const subjects = spawnSync('git', ['-C', PROJECT_ROOT, 'log', '--format=%s'], { encoding: 'utf-8' }).stdout || '';
  const missing = tasks.map((t) => t.id).filter((id) => !subjects.includes(`feat(${id}):`));
  (missing.length === 0)
    ? pass('per-task commit for every task', `${tasks.length} feat(TASK-*) commits`)
    : fail('per-task commit for every task', `missing: ${missing.join(',')}`);

  // 2b) no secret-bearing files anywhere in reachable history
  const leak = spawnSync('git', ['-C', PROJECT_ROOT, 'log', '--all', '--name-only', '--format='], { encoding: 'utf-8' }).stdout || '';
  const leaked = [...new Set((leak.match(/^(\.env(\.\w+)?|\.dev\.vars\S*|.*\.swp)$/gm) || []))].filter((f) => !f.endsWith('.example'));
  (leaked.length === 0) ? pass('no secret/swap files in git history') : fail('no secret/swap files in git history', leaked.join(', '));

  // 3) a live deploy exists
  const dep = spawnSync('npx', ['wrangler', 'deployments', 'list'], { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000 });
  (dep.status === 0 && new RegExp(`${DOMAIN.split('.')[0]}|Version|Created`, 'i').test(dep.stdout || ''))
    ? pass('wrangler deployment exists') : fail('wrangler deployment exists', (dep.stderr || dep.stdout || '').slice(-160));

  // 4) live site responds + apex→www redirect
  try {
    const apex = await fetch(`https://${DOMAIN}/`, { redirect: 'manual' });
    ([301, 302, 307, 308].includes(apex.status) && /www\./.test(apex.headers.get('location') || ''))
      ? pass('apex → www redirect', `${apex.status} → ${apex.headers.get('location')}`)
      : (apex.ok ? pass('apex responds (no redirect seen)', `HTTP ${apex.status}`) : fail('apex → www redirect', `HTTP ${apex.status}`));
  } catch (e) { fail('apex → www redirect', e.message); }
  try {
    const www = await fetch(`https://www.${DOMAIN}/`);
    www.ok ? pass(`https://www.${DOMAIN} responds`, `HTTP ${www.status}`) : fail('www responds', `HTTP ${www.status}`);
  } catch (e) { fail('www responds', e.message); }
  try {
    const h = await fetch(`https://www.${DOMAIN}/api/health`);
    const j = await h.json().catch(() => ({}));
    (h.ok && j.ok === true) ? pass('/api/health ok', `HTTP ${h.status}`) : fail('/api/health ok', `HTTP ${h.status}`);
  } catch (e) { fail('/api/health ok', e.message); }

  let ok = 0;
  for (const c of checks) { console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.n}${c.d ? ' — ' + c.d : ''}`); if (c.ok) ok++; }
  console.log(`\n${ok}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
