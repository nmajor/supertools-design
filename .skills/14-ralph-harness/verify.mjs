#!/usr/bin/env node
// 14-ralph-harness verifier.
// Proves the engine WITHOUT real product work or touching the app tree:
//   1. all engine files present + bash -n clean
//   2. all 3 CLIs respond non-interactively (live ping)
//   3. task-state + verdict + promise libs behave (unit)
//   4. FULL drivers run end-to-end on a THROWAWAY scratch repo with SHIM agents
//      (deterministic, no cost): plan-council reaches unanimous approval; the
//      build loop implements→reviews→commits→COMPLETE on ralph/build.
// The shimmed e2e is explicitly labeled: real agents drive the live runs in
// skills 15/16. This gate proves wiring + loop logic, not model quality.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../_shared/env.mjs';

const checks = [];
const pass = (n, d = '') => checks.push({ n, ok: true, d });
const fail = (n, d = '') => checks.push({ n, ok: false, d });
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf-8', timeout: 150000, ...opts });

const RL = path.join(PROJECT_ROOT, 'scripts', 'ralph-local');
const AG = path.join(PROJECT_ROOT, '.agent');

async function fileChecks() {
  const files = [
    'scripts/ralph-local/ralph-plan-council.sh', 'scripts/ralph-local/ralph-council.sh',
    'scripts/ralph-local/lib/common.sh', 'scripts/ralph-local/lib/agents-local.sh',
    'scripts/ralph-local/lib/task-state.sh', 'scripts/ralph-local/lib/promise.sh',
    '.agent/PROMPT.md', '.agent/DECISIONS.md', '.agent/STEERING.md', '.agent/planning-status.json',
    '.agent/council/PLAN_GENERATOR.md', '.agent/council/PLAN_REVIEWER.md', '.agent/council/BUILD_TASK.md',
    '.agent/council/CODE_REVIEWER.md', '.agent/council/INTEGRATION_REVIEWER.md', '.agent/council/FIX_REVIEW.md',
  ];
  for (const f of files) (await exists(path.join(PROJECT_ROOT, f))) ? pass(`file ${f}`) : fail(`file ${f}`, 'missing');
  // promise.sh is the vendored upstream file
  const prom = await fs.readFile(path.join(RL, 'lib', 'promise.sh'), 'utf-8').catch(() => '');
  /PROMISE_COMPLETE_PATTERN/.test(prom) ? pass('promise.sh vendored (upstream)') : fail('promise.sh vendored', 'not the upstream file');
  // no sbx residue in the de-dockerized engine
  for (const f of ['ralph-plan-council.sh', 'ralph-council.sh', 'lib/agents-local.sh', 'lib/common.sh', 'lib/task-state.sh']) {
    const t = await fs.readFile(path.join(RL, f), 'utf-8').catch(() => '');
    // Flag only executable sbx usage, not explanatory comments (lines starting with #).
    const codeLines = t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    /\bsbx\b/.test(codeLines) ? fail(`no sbx in ${f}`, 'found executable sbx reference') : pass(`no sbx in ${f}`);
    const syn = sh('bash', ['-n', path.join(RL, f)]);
    syn.status === 0 ? pass(`bash -n ${f}`) : fail(`bash -n ${f}`, (syn.stderr || '').slice(-200));
  }
}

function cliPings() {
  const ping = (name, cmd, args, input) => {
    const r = sh(cmd, args, input != null ? { input } : {});
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    (r.status === 0 && /PING_OK/.test(out)) ? pass(`${name} responds`, 'PING_OK')
      : fail(`${name} responds`, `exit ${r.status} (no PING_OK) ${out.slice(-120).replace(/\n/g, ' ')}`);
  };
  ping('claude', 'claude', ['-p', '--model', 'opus', '--permission-mode', 'bypassPermissions'], 'Reply with exactly: PING_OK');
  ping('codex', 'codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.5', '-'], 'Reply with exactly: PING_OK');
  ping('gemini', 'gemini', ['-m', 'gemini-2.5-pro', '-y', '-p', 'Reply with exactly: PING_OK']);
}

async function libUnit() {
  // Exercise task-state.sh + verdict() against a temp fixture, deterministically.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ralph-unit-'));
  await fs.mkdir(path.join(tmp, 'scripts', 'ralph-local'), { recursive: true });
  await fs.cp(path.join(RL, 'lib'), path.join(tmp, 'scripts', 'ralph-local', 'lib'), { recursive: true });
  await fs.mkdir(path.join(tmp, '.agent', 'tasks'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.agent', 'planning-status.json'), '{"status":"not_started","revision":0}\n');
  await fs.writeFile(path.join(tmp, '.agent', 'tasks.json'), JSON.stringify([
    { id: 'TASK-1', title: 'prereq', priority: 100, passes: false, blocked: false },
    { id: 'TASK-2', title: 'feat', priority: 90, passes: false, blocked: false },
    { id: 'TASK-3', title: 'late', priority: 10, passes: false, blocked: true },
  ]) + '\n');
  const script = `
set -e
source "${path.join(tmp, 'scripts', 'ralph-local', 'lib', 'common.sh')}"
source "${path.join(tmp, 'scripts', 'ralph-local', 'lib', 'task-state.sh')}"
source "${path.join(tmp, 'scripts', 'ralph-local', 'lib', 'agents-local.sh')}"
[ "$(next_task_id)" = "TASK-1" ] || { echo "FAIL next_task_id=$(next_task_id)"; exit 1; }
mark_task_pass TASK-1
[ "$(next_task_id)" = "TASK-2" ] || { echo "FAIL after pass: $(next_task_id)"; exit 1; }
all_tasks_pass && { echo "FAIL all_tasks_pass too early"; exit 1; }
mark_task_pass TASK-2
[ "$(task_remaining)" = "0" ] || { echo "FAIL remaining=$(task_remaining)"; exit 1; }
# TASK-3 is blocked+unpassed: runnable is 0 but the work is NOT all done.
all_tasks_pass && { echo "FAIL all_tasks_pass true with a blocked-unpassed task"; exit 1; }
[ "$(blocked_incomplete)" = "1" ] || { echo "FAIL blocked_incomplete=$(blocked_incomplete)"; exit 1; }
[ "$(tasks_passed)" = "2" ] || { echo "FAIL tasks_passed=$(tasks_passed)"; exit 1; }
echo "x CODE_APPROVED" > "${tmp}/v1"; [ "$(verdict "${tmp}/v1" CODE_APPROVED CODE_REJECTED)" = approved ] || { echo FAIL v-approve; exit 1; }
echo "CODE_REJECTED later" > "${tmp}/v2"; [ "$(verdict "${tmp}/v2" CODE_APPROVED CODE_REJECTED)" = rejected ] || { echo FAIL v-reject; exit 1; }
set_planning_status approved "unit"; [ "$(planning_status)" = approved ] || { echo FAIL status; exit 1; }
echo UNIT_OK
`;
  const r = sh('bash', ['-c', script]);
  /UNIT_OK/.test(r.stdout || '') ? pass('lib unit (task-state/verdict/status)')
    : fail('lib unit', ((r.stdout || '') + (r.stderr || '')).slice(-300));
  await fs.rm(tmp, { recursive: true, force: true });
}

// Deterministic shim agents shared by the e2e tests. The generator WRITES the
// plan (proving the generator path); the reviewer's verdict is controlled by
// $REVIEW_VERDICT (approve|reject); the implementer makes a diff + DONE tag.
async function makeShims(shim) {
  await fs.mkdir(shim, { recursive: true });
  const claude = `#!/usr/bin/env bash
p="$(cat)"
A="$SCRATCH_ROOT/.agent"
if echo "$p" | grep -q "Plan Generator"; then
  mkdir -p "$A/tasks" "$A/prd"
  printf '[{"id":"TASK-1","title":"scratch smoke task","priority":100,"type":"infra","specFilePath":".agent/tasks/TASK-1.json","passes":false,"blocked":false}]\\n' > "$A/tasks.json"
  printf '{"id":"TASK-1","title":"scratch smoke task","goal":"prove the loop","acceptanceCriteria":["a file changes"],"tests":["true"],"integration":["n/a"]}\\n' > "$A/tasks/TASK-1.json"
  printf '# scratch\\n' > "$A/prd/SUMMARY.md"; printf '# scratch PRD\\n' > "$A/prd/PRD.md"
  echo "generated plan"; exit 0
elif echo "$p" | grep -q "Adversarial Plan Reviewer"; then echo "looks complete"; echo PLAN_APPROVED
elif echo "$p" | grep -qi "ONE TASK PER INVOCATION"; then
  id="$(echo "$p" | grep -oE 'TASK-[0-9]+' | head -1)"
  echo "scratch $(date +%s%N)" >> "$SCRATCH_ROOT/work.txt"
  echo "<promise>$id:DONE</promise>"
elif echo "$p" | grep -q "Fix Review Findings"; then echo fix >> "$SCRATCH_ROOT/work.txt"; echo done
else echo OK; fi
`;
  const reviewer = `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
echo "reviewed"
if [ "\${REVIEW_VERDICT:-approve}" = reject ]; then echo PLAN_REJECTED; echo CODE_REJECTED; else echo PLAN_APPROVED; echo CODE_APPROVED; fi
`;
  await fs.writeFile(path.join(shim, 'claude'), claude, { mode: 0o755 });
  await fs.writeFile(path.join(shim, 'codex'), reviewer, { mode: 0o755 });
  await fs.writeFile(path.join(shim, 'gemini'), reviewer, { mode: 0o755 });
}

async function playwrightChecks() {
  (await exists(path.join(PROJECT_ROOT, 'node_modules', '.bin', 'playwright')))
    ? pass('@playwright/test installed') : fail('@playwright/test installed', 'node_modules/.bin/playwright missing');
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  let chromium = false;
  try { chromium = (await fs.readdir(cache)).some((d) => /chromium/i.test(d)); } catch {}
  chromium ? pass('playwright chromium installed') : fail('playwright chromium installed', `no chromium under ${cache}`);
}

async function stubbedE2E() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ralph-e2e-'));
  const shim = path.join(scratch, '.shim');
  try {
    // Seed engine + .agent into the scratch repo.
    await fs.mkdir(path.join(scratch, 'scripts'), { recursive: true });
    await fs.cp(RL, path.join(scratch, 'scripts', 'ralph-local'), { recursive: true });
    await fs.cp(AG, path.join(scratch, '.agent'), { recursive: true });
    await fs.writeFile(path.join(scratch, '.agent', 'planning-status.json'), '{"status":"not_started","revision":0}\n');
    // Start with an EMPTY plan — the generator shim must create tasks.json (proves
    // the generator path, not just the approval gate).
    await fs.writeFile(path.join(scratch, '.agent', 'tasks.json'), '[]\n');

    // git init + identity (reproducible) + initial commit so the task diff is clean.
    sh('git', ['init', '-q'], { cwd: scratch });
    sh('git', ['config', 'user.email', 'ralph@supertools.test'], { cwd: scratch });
    sh('git', ['config', 'user.name', 'Ralph Verify'], { cwd: scratch });
    sh('git', ['add', '-A'], { cwd: scratch });
    sh('git', ['commit', '-q', '-m', 'scratch init'], { cwd: scratch });

    await makeShims(shim);
    const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, SCRATCH_ROOT: scratch, MAX_PLAN_ROUNDS: '1' };

    // Plan council → expect approved.
    const pc = sh('bash', [path.join(scratch, 'scripts', 'ralph-local', 'ralph-plan-council.sh')], { cwd: scratch, env });
    const ps = JSON.parse(await fs.readFile(path.join(scratch, '.agent', 'planning-status.json'), 'utf-8').catch(() => '{}'));
    (pc.status === 0 && ps.status === 'approved') ? pass('plan-council → unanimous approved (shim)')
      : fail('plan-council → approved', `exit ${pc.status} status=${ps.status} ${(pc.stdout || pc.stderr || '').slice(-200)}`);

    // Seed a PRE-EXISTING unrelated dirty change before the build loop — it must
    // be captured in the baseline commit, NOT swept into the task's commit.
    await fs.writeFile(path.join(scratch, 'unrelated.txt'), 'pre-existing dirty edit\n');

    // Build loop (2 iters) → expect COMPLETE exit 0, task passes, commit on ralph/build.
    const bc = sh('bash', [path.join(scratch, 'scripts', 'ralph-local', 'ralph-council.sh'), '2'], { cwd: scratch, env });
    const tasks = JSON.parse(await fs.readFile(path.join(scratch, '.agent', 'tasks.json'), 'utf-8').catch(() => '[]'));
    const t1 = tasks.find((t) => t.id === 'TASK-1');
    bc.status === 0 ? pass('build-council → COMPLETE (exit 0)') : fail('build-council → COMPLETE', `exit ${bc.status} ${(bc.stdout || bc.stderr || '').slice(-200)}`);
    (t1 && t1.passes === true) ? pass('build-council marked TASK-1 passes') : fail('build-council marked TASK-1 passes', JSON.stringify(t1));
    const branch = sh('git', ['branch', '--show-current'], { cwd: scratch }).stdout.trim();
    const commits = sh('git', ['log', '--oneline'], { cwd: scratch }).stdout.trim().split('\n').filter(Boolean);
    branch === 'ralph/build' ? pass('build ran on ralph/build branch') : fail('build branch', `on ${branch}`);
    commits.some((c) => /feat\(TASK-1\)/.test(c)) ? pass('per-task commit created') : fail('per-task commit created', commits.join(' | ').slice(0, 200));

    // Isolation regression: unrelated.txt in the baseline commit, NOT the task commit.
    const logl = sh('git', ['log', '--format=%H %s'], { cwd: scratch }).stdout.trim().split('\n');
    const taskC = (logl.find((l) => /feat\(TASK-1\)/.test(l)) || '').split(' ')[0];
    const baseC = (logl.find((l) => /chore\(ralph\): baseline/.test(l)) || '').split(' ')[0];
    const taskFiles = taskC ? sh('git', ['show', '--name-only', '--format=', taskC], { cwd: scratch }).stdout : '';
    const baseFiles = baseC ? sh('git', ['show', '--name-only', '--format=', baseC], { cwd: scratch }).stdout : '';
    (taskFiles.includes('work.txt') && !taskFiles.includes('unrelated.txt'))
      ? pass('task commit isolated (only its own work)') : fail('task commit isolated', `task files: ${taskFiles.replace(/\n/g, ',')}`);
    (baseC && baseFiles.includes('unrelated.txt'))
      ? pass('pre-existing dirty change captured in baseline commit') : fail('dirty change → baseline commit', `base files: ${baseFiles.replace(/\n/g, ',')}`);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

// A task left blocked-and-unpassed must NOT let the loop report COMPLETE.
async function blockedCompletionTest() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ralph-blk-'));
  try {
    await fs.mkdir(path.join(scratch, 'scripts'), { recursive: true });
    await fs.cp(RL, path.join(scratch, 'scripts', 'ralph-local'), { recursive: true });
    await fs.cp(AG, path.join(scratch, '.agent'), { recursive: true });
    await fs.writeFile(path.join(scratch, '.agent', 'planning-status.json'), '{"status":"approved","revision":1}\n');
    await fs.writeFile(path.join(scratch, '.agent', 'tasks.json'), JSON.stringify([
      { id: 'TASK-1', title: 'blocked task', priority: 100, passes: false, blocked: true,
        specFilePath: '.agent/tasks/TASK-1.json' },
    ]) + '\n');
    sh('git', ['init', '-q'], { cwd: scratch });
    sh('git', ['config', 'user.email', 'ralph@supertools.test'], { cwd: scratch });
    sh('git', ['config', 'user.name', 'Ralph Verify'], { cwd: scratch });
    sh('git', ['add', '-A'], { cwd: scratch }); sh('git', ['commit', '-q', '-m', 'init'], { cwd: scratch });
    const r = sh('bash', [path.join(scratch, 'scripts', 'ralph-local', 'ralph-council.sh'), '1'], { cwd: scratch });
    // EXIT_BLOCKED = 2, EXIT_COMPLETE = 0. Must NOT be 0.
    (r.status === 2) ? pass('blocked-only tasks → BLOCKED (not COMPLETE)')
      : fail('blocked-only tasks → BLOCKED', `exit ${r.status} (expected 2) ${(r.stdout || r.stderr || '').slice(-160)}`);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

// A CODE_REJECTED task must NOT leave its diff to be swept into a baseline commit
// on a later run — the rejected code must never land in git history.
async function rejectedResumeTest() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ralph-rej-'));
  const shim = path.join(scratch, '.shim');
  try {
    await fs.mkdir(path.join(scratch, 'scripts'), { recursive: true });
    await fs.cp(RL, path.join(scratch, 'scripts', 'ralph-local'), { recursive: true });
    await fs.cp(AG, path.join(scratch, '.agent'), { recursive: true });
    await fs.writeFile(path.join(scratch, '.agent', 'planning-status.json'), '{"status":"approved","revision":1}\n');
    await fs.mkdir(path.join(scratch, '.agent', 'tasks'), { recursive: true });
    await fs.writeFile(path.join(scratch, '.agent', 'tasks.json'), JSON.stringify([
      { id: 'TASK-1', title: 'will be rejected', priority: 100, passes: false, blocked: false,
        specFilePath: '.agent/tasks/TASK-1.json' },
    ]) + '\n');
    await fs.writeFile(path.join(scratch, '.agent', 'tasks', 'TASK-1.json'), '{"id":"TASK-1","goal":"x","acceptanceCriteria":["x"],"tests":["true"]}\n');
    await fs.writeFile(path.join(scratch, '.agent', 'prd', 'SUMMARY.md'), '# s\n');
    sh('git', ['init', '-q'], { cwd: scratch });
    sh('git', ['config', 'user.email', 'ralph@supertools.test'], { cwd: scratch });
    sh('git', ['config', 'user.name', 'Ralph Verify'], { cwd: scratch });
    sh('git', ['add', '-A'], { cwd: scratch }); sh('git', ['commit', '-q', '-m', 'init'], { cwd: scratch });
    await makeShims(shim);
    const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, SCRATCH_ROOT: scratch, REVIEW_VERDICT: 'reject', MAX_REVIEW_ROUNDS: '1' };

    const r1 = sh('bash', [path.join(scratch, 'scripts', 'ralph-local', 'ralph-council.sh'), '1'], { cwd: scratch, env });
    (r1.status === 2) ? pass('rejected task → BLOCKED (not committed)') : fail('rejected task → BLOCKED', `exit ${r1.status}`);
    // Resume: a second run must not fold the rejected diff into a baseline commit.
    const r2 = sh('bash', [path.join(scratch, 'scripts', 'ralph-local', 'ralph-council.sh'), '1'], { cwd: scratch, env });
    // Check BRANCH history only (--branches) — the rejected diff lives in the
    // stash by design (forensics), which --all would include as a false positive.
    const histFiles = sh('git', ['log', '--branches', '--name-only', '--format='], { cwd: scratch }).stdout;
    const stashed = sh('git', ['stash', 'list'], { cwd: scratch }).stdout;
    (!histFiles.includes('work.txt') && /ralph-rejected-TASK-1/.test(stashed))
      ? pass('rejected diff stashed, never in branch history (incl. resume baseline)')
      : fail('rejected diff never committed', `inBranch=${histFiles.includes('work.txt')} stash="${stashed.trim().slice(0, 60)}"`);
    [0, 2].includes(r2.status) ? pass('resume after rejection is safe') : fail('resume after rejection', `exit ${r2.status}`);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

async function main() {
  await fileChecks();
  cliPings();
  await playwrightChecks();
  await libUnit();
  await stubbedE2E();
  await blockedCompletionTest();
  await rejectedResumeTest();

  let ok = 0;
  for (const c of checks) { console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.n}${c.d ? ' — ' + c.d : ''}`); if (c.ok) ok++; }
  console.log(`\n${ok}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
