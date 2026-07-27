// Clone (or refresh) external skill-pack repos into a project-local cache.
// Always tracks main; records the resolved SHA so skill receipts can reproduce.
//
// Cache: <project>/.supertools-state/_cache/<repo>/

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from './env.mjs';

const CACHE_DIR = path.join(PROJECT_ROOT, '.supertools-state', '_cache');

// Add new repos here as later skills need them.
const REPOS = {
  'supertools-stack':  'https://github.com/nmajor/supertools-stack.git',
  'supertools-design': 'https://github.com/nmajor/supertools-design.git',
  'ralph-loop':        'https://github.com/PageAI-Pro/ralph-loop.git',
};

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} (cwd=${cwd}) exited ${r.status}\n` +
      (r.stderr || r.stdout || '').slice(0, 1000)
    );
  }
  return (r.stdout || '').trim();
}

export async function ensureRepo(name) {
  const url = REPOS[name];
  if (!url) throw new Error(`Unknown repo "${name}". Add it to .skills/_shared/repos.mjs.`);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const dest = path.join(CACHE_DIR, name);

  let cloned = false;
  let updated = false;
  try {
    await fs.access(path.join(dest, '.git'));
    try {
      git(['fetch', '--quiet', 'origin'], dest);
      git(['reset', '--hard', '--quiet', 'origin/HEAD'], dest);
      updated = true;
    } catch (e) {
      console.warn(`  (could not refresh ${name}, using existing checkout: ${e.message.split('\n')[0]})`);
    }
  } catch {
    git(['clone', '--quiet', url, dest], CACHE_DIR);
    cloned = true;
  }

  const sha = git(['rev-parse', 'HEAD'], dest);
  const status = cloned ? 'freshly cloned' : updated ? 'updated to latest main' : 'existing checkout';
  console.log(`  ${name} @ ${sha.slice(0, 12)} (${status})`);
  return { name, path: dest, sha, url };
}

// Best-effort commit + push of any local changes in a cached repo back to
// origin/main. Never throws and never causes the caller to fail — if the
// user doesn't have push perms (or git identity, or network), we log and
// move on. Returns a structured summary suitable for receipts.
export function tryPushChanges(repoPath, commitMessage) {
  const result = { attempted: true, hadChanges: false, committed: false, pushed: false, note: '' };
  try {
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: repoPath, encoding: 'utf-8',
    });
    if (status.status !== 0) {
      result.note = `git status failed: ${(status.stderr || '').split('\n')[0]}`;
      console.log(`  ${result.note}`);
      return result;
    }
    if (!status.stdout.trim()) {
      result.note = 'no local changes';
      console.log('  no changes to push upstream');
      return result;
    }
    result.hadChanges = true;
    const fileCount = status.stdout.trim().split('\n').length;
    console.log(`  ${fileCount} change(s) detected; committing + pushing best-effort...`);

    const add = spawnSync('git', ['add', '-A'], { cwd: repoPath, encoding: 'utf-8' });
    if (add.status !== 0) {
      result.note = 'git add failed';
      console.log(`  ${result.note}; abandoning sync`);
      return result;
    }

    const commit = spawnSync('git', ['commit', '-m', commitMessage], {
      cwd: repoPath, encoding: 'utf-8',
    });
    if (commit.status !== 0) {
      result.note = `git commit failed: ${(commit.stderr || '').split('\n')[0]}`;
      console.log(`  ${result.note} (likely missing git identity); abandoning sync`);
      return result;
    }
    result.committed = true;

    const push = spawnSync('git', ['push', 'origin', 'HEAD:main'], {
      cwd: repoPath, encoding: 'utf-8',
    });
    if (push.status !== 0) {
      result.note = 'push failed — no perms, no remote write, or offline';
      console.log(`  ${result.note}; local commit kept until next ensureRepo wipe`);
      return result;
    }
    result.pushed = true;
    result.note = 'pushed to origin/main';
    console.log('  ✓ pushed to origin/main');
    return result;
  } catch (e) {
    result.note = `sync errored: ${e.message.slice(0, 200)}`;
    console.log(`  ${result.note}`);
    return result;
  }
}
