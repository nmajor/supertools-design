#!/usr/bin/env node
// 01-project-init setup: scaffold the app stack into the project root.
// Snapshots preserved files, runs supertools-stack install.sh into a tmp dir,
// rsyncs the scaffold back, runs npm install, and hardens .gitignore +
// tsconfig.json. Idempotent. Two
// deliberate deviations, both recorded in the receipt:
//
//   1. STACK SOURCE: the LOCAL checkout at /home/coder/projects/supertools-stack
//      is preferred over a GitHub clone. As of 2026-07-03 the local checkout
//      carries 14 commits (install-steps v0.4–v0.11: db, foundation, auth,
//      email, password-reset, auth-hardening, marketing, dashboard, legal)
//      that origin/main does NOT have; origin/main only adds ralph-harness
//      commits. Cloning GitHub would silently scaffold a far thinner stack.
//      The receipt records the local SHA + dirty state + the divergence.
//   2. --no-refresh and NO push-back: we neither mutate the user's diverged
//      stack repo with a dep refresh nor attempt to push to it. Reconciling
//      the divergence is surfaced as a founder to-do instead.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../_shared/env.mjs';
import { ensureRepo } from '../_shared/repos.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '01-project-init');
const LOCAL_STACK = '/home/coder/projects/supertools-stack';
export const PRESERVED = [
  'CLAUDE.md', 'design', 'docs', 'research', '.env', '.env.example',
  '.gitignore', '.skills', '.supertools-state',
];

const log = (...a) => console.log(...a);
const die = (msg) => { console.error(msg); process.exit(1); };

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

async function snapshotManifest() {
  const { createHash } = await import('node:crypto');
  const manifest = {};
  for (const p of PRESERVED) {
    const abs = path.join(PROJECT_ROOT, p);
    try {
      const stat = await fs.lstat(abs);
      const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file';
      const entry = { kind, size: stat.size, mtime: stat.mtimeMs };
      // Content hash for plain files — lets verifyManifest prove the merge
      // left them byte-identical, not merely present.
      if (kind === 'file') {
        entry.sha256 = createHash('sha256').update(await fs.readFile(abs)).digest('hex');
      }
      manifest[p] = entry;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  await fs.writeFile(
    path.join(STATE_SUB, 'preserved-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  return manifest;
}

// Runs IMMEDIATELY after the rsync merge — before the skill's own documented
// hardening edits — so it proves the MERGE touched nothing preserved.
async function verifyManifest(before) {
  const { createHash } = await import('node:crypto');
  const issues = [];
  for (const p of Object.keys(before)) {
    const abs = path.join(PROJECT_ROOT, p);
    try {
      const stat = await fs.lstat(abs);
      const expected = before[p].kind;
      const actual = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file';
      if (actual !== expected) {
        issues.push(`${p}: kind changed (was ${expected}, is ${actual})`);
        continue;
      }
      if (expected === 'file' && before[p].sha256) {
        const now = createHash('sha256').update(await fs.readFile(abs)).digest('hex');
        if (now !== before[p].sha256) issues.push(`${p}: content changed by the merge`);
      }
    } catch (e) {
      if (e.code === 'ENOENT') issues.push(`${p}: missing after merge`);
      else throw e;
    }
  }
  return issues;
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || PROJECT_ROOT,
    stdio: opts.stdio || ['ignore', 'inherit', 'inherit'],
    encoding: 'utf-8',
    env: { ...process.env, ...(opts.env || {}) },
    maxBuffer: 200 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
  }
  return r;
}

// Resolve the stack source: local checkout preferred (see header), GitHub
// clone as fallback for other machines.
async function resolveStack() {
  try {
    await fs.access(path.join(LOCAL_STACK, 'install.sh'));
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: LOCAL_STACK, encoding: 'utf-8' }).stdout.trim();
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: LOCAL_STACK, encoding: 'utf-8' }).stdout.trim() !== '';
    const ahead = spawnSync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: LOCAL_STACK, encoding: 'utf-8' }).stdout.trim();
    const behind = spawnSync('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: LOCAL_STACK, encoding: 'utf-8' }).stdout.trim();
    return {
      source: 'local-checkout', path: LOCAL_STACK, sha, dirty,
      divergence: `local is ${ahead} ahead / ${behind} behind origin/main (origin lacks the install-steps; reconcile is a founder to-do)`,
    };
  } catch {
    log('  (local stack checkout not found — falling back to GitHub clone)');
    const repo = await ensureRepo('supertools-stack');
    return { source: 'github-clone', path: repo.path, sha: repo.sha, dirty: false, divergence: null };
  }
}

async function runInstall(stackRepoPath, tmpProject) {
  const installLog = path.join(STATE_SUB, 'install-output.log');
  log(`▶ Running install.sh into ${tmpProject} (this can take several minutes)...`);
  const r = spawnSync(
    'bash',
    [path.join(stackRepoPath, 'install.sh'), tmpProject, '--no-refresh'],
    {
      cwd: stackRepoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      maxBuffer: 200 * 1024 * 1024,
    }
  );
  const combined = (r.stdout || '') + '\n---STDERR---\n' + (r.stderr || '');
  await fs.writeFile(installLog, combined);
  if (r.status !== 0) {
    die(`install.sh exited ${r.status}. See ${installLog}`);
  }
  log(`  install.sh succeeded; log saved to ${installLog}`);
  return installLog;
}

function stripJsonComments(text) {
  // JSONC-tolerant: strip // line and /* block comments without touching
  // string literals, then strip trailing commas. Comments are lost on
  // rewrite; for tsconfig.json that loss is acceptable.
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true; out += c; i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += c; i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

async function hardenTsConfig() {
  // The scaffold's tsconfig typechecks everything; exclude non-app folders.
  // File is JSONC (has comments); rewrite drops them — accepted trade-off.
  const tsPath = path.join(PROJECT_ROOT, 'tsconfig.json');
  let raw;
  try { raw = await fs.readFile(tsPath, 'utf-8'); }
  catch { log('  (no tsconfig.json; skipping ts harden)'); return; }
  const cfg = JSON.parse(stripJsonComments(raw));
  const wantExclude = [
    'node_modules', 'dist', '.output', '.tanstack', '.wrangler',
    'design', 'docs', 'research', '.skills', '.supertools-state',
  ];
  const existing = Array.isArray(cfg.exclude) ? cfg.exclude : [];
  const merged = [...new Set([...existing, ...wantExclude])];
  const added = merged.filter((m) => !existing.includes(m));
  if (added.length === 0) {
    log('  tsconfig.json exclude already covers the non-app folders');
    return;
  }
  cfg.exclude = merged;
  await fs.writeFile(tsPath, JSON.stringify(cfg, null, 2) + '\n');
  log(`  patched tsconfig.json exclude (+${added.length}: ${added.join(', ')})`);
}

async function hardenGitignore() {
  const giPath = path.join(PROJECT_ROOT, '.gitignore');
  let text = '';
  try { text = await fs.readFile(giPath, 'utf-8'); } catch {}
  const targets = ['.env', '.env.local', '.dev.vars', 'node_modules/', 'dist/', '.wrangler/', '.output/', '.tanstack/'];
  let lines = text.split('\n');
  let changed = false;
  for (const t of targets) {
    const bare = t.replace(/\/$/, '');
    if (!lines.some((l) => l.trim() === t || l.trim() === bare)) {
      lines.push(t);
      changed = true;
    }
  }
  if (changed) {
    await fs.writeFile(giPath, lines.join('\n'));
    log('  hardened .gitignore (env + build dirs)');
  } else {
    log('  .gitignore already covers env + build dirs');
  }
}

async function main() {
  // No loadEnv() — this skill reads no .env keys (only runtime FORCE_REINIT).
  await ensureDir(STATE_SUB);

  // Idempotency gate: if this skill already finalized, no-op. Set
  // FORCE_REINIT=1 to intentionally re-scaffold.
  const receiptPath = path.join(PROJECT_ROOT, '.supertools-state', '01-project-init.json');
  if (process.env.FORCE_REINIT !== '1') {
    try {
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf-8'));
      if (receipt.status === 'ok') {
        log('01-project-init already complete (receipt status=ok). No-op.');
        log('  To force a re-scaffold: FORCE_REINIT=1 node .skills/01-project-init/setup.mjs');
        console.log('---SETUP_DONE---');
        console.log(JSON.stringify({ skipped: true, reason: 'existing receipt', receiptPath }, null, 2));
        return;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // no receipt yet → proceed
    }
  } else {
    log('  FORCE_REINIT=1 — re-scaffolding even though a receipt may exist.');
  }

  // Sanity: prereqs receipt must be ok.
  const prereqs = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', '00-prereqs.json'), 'utf-8')
  );
  if (prereqs.status !== 'ok') die(`00-prereqs receipt is ${prereqs.status}; halting.`);

  log('▶ Resolving supertools-stack source...');
  const stack = await resolveStack();
  log(`  ${stack.source} @ ${stack.sha}${stack.dirty ? ' (dirty working tree)' : ''}`);
  if (stack.divergence) log(`  NOTE: ${stack.divergence}`);

  log('▶ Snapshotting preserved files...');
  const before = await snapshotManifest();
  log(`  ${Object.keys(before).length} preserved entries`);

  const ts = Math.floor(Date.now() / 1000);
  // Scratch space for the throwaway scaffold before it is merged in.
  // SCRATCHPAD_DIR lets a harness point this at its own workspace.
  const scratchBase = process.env.SCRATCHPAD_DIR || os.tmpdir();
  const tmpRoot = path.join(scratchBase, `scaffold-${ts}`);
  const projectName = path.basename(PROJECT_ROOT);
  const tmpProject = path.join(tmpRoot, projectName);

  await runInstall(stack.path, tmpProject);

  log(`▶ Merging scaffold into ${PROJECT_ROOT}...`);
  // Two layers of protection for preserved paths:
  //   1. Each PRESERVED entry is excluded from rsync — anchored with a
  //      leading slash so it matches only the top-level entry. The scaffold
  //      can neither overwrite nor ADD new files inside them.
  //   2. --ignore-existing as defense-in-depth for any non-preserved file.
  const buildArtifactExcludes = ['node_modules/', '.git/', '.last-refresh'];
  const preservedExcludes = PRESERVED.map((p) => `/${p}`);
  // Drizzle generates RANDOM migration filenames per scaffold run. If the
  // project already has a drizzle/ dir, a re-merge would inject a duplicate
  // initial migration under a new name ("table already exists" on apply) —
  // so an existing drizzle/ is excluded wholesale from re-merges.
  const dynamicExcludes = [];
  try { await fs.access(path.join(PROJECT_ROOT, 'drizzle')); dynamicExcludes.push('/drizzle'); } catch {}
  if (dynamicExcludes.length) log(`  re-merge excludes: ${dynamicExcludes.join(', ')} (already present)`);
  const excludes = [...preservedExcludes, ...dynamicExcludes, ...buildArtifactExcludes];
  const excludeArgs = excludes.flatMap((e) => ['--exclude', e]);
  run('rsync', ['-a', '--ignore-existing',
    ...excludeArgs, tmpProject + '/', PROJECT_ROOT + '/']);

  log('▶ Verifying the merge touched nothing preserved (content hashes)...');
  const mergeIssues = await verifyManifest(before);
  if (mergeIssues.length) {
    die(`Preserved-file integrity check failed:\n  ${mergeIssues.join('\n  ')}`);
  }
  log(`  ${Object.keys(before).length} preserved entries intact`);

  log('▶ Running npm install...');
  run('npm', ['install', '--no-fund', '--no-audit']);

  const gitDir = path.join(PROJECT_ROOT, '.git');
  let gitInitialized = false;
  try {
    await fs.access(gitDir);
    log('  .git/ already exists; skipping git init');
  } catch {
    log('▶ git init...');
    run('git', ['init', '--initial-branch=main']);
    gitInitialized = true;
  }

  log('▶ Hardening .gitignore...');
  await hardenGitignore();

  log('▶ Hardening tsconfig.json...');
  await hardenTsConfig();

  const summary = {
    tmpScaffoldDir: tmpProject,
    projectName,
    gitInitialized,
    preservedCount: Object.keys(before).length,
    supertoolsStack: stack,
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(STATE_SUB, 'merge-summary.json'),
    JSON.stringify(summary, null, 2) + '\n'
  );

  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

// Only run when executed directly — verify.mjs imports PRESERVED from this
// module, and an import must never trigger a scaffold run.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
