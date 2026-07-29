#!/usr/bin/env node
// 01-project-init setup: scaffold the app stack into the project root.
// Snapshots preserved files, runs supertools-stack install.sh into a tmp dir,
// rsyncs the scaffold back, runs npm install, and hardens .gitignore +
// tsconfig.json. Idempotent.
//
// STACK SOURCE resolution order (the chosen source + SHA go in the receipt):
//   1. $SUPERTOOLS_STACK_DIR — an explicit local checkout.
//   2. A sibling checkout next to this project (../supertools-stack).
//   3. A fresh clone of github.com/nmajor/supertools-stack.
//
// A local checkout is used as-is: no dep refresh, no push-back. If it has
// commits origin/main lacks, that divergence is reported in the receipt so it
// can be reconciled deliberately rather than silently scaffolded from.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../_shared/env.mjs';
import { ensureRepo } from '../_shared/repos.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '01-project-init');
// Candidate local checkouts, in preference order. Empty/missing entries are
// skipped; if none has an install.sh we clone from GitHub.
const STACK_CANDIDATES = [
  process.env.SUPERTOOLS_STACK_DIR,
  path.resolve(PROJECT_ROOT, '..', 'supertools-stack'),
].filter(Boolean);
export const PRESERVED = [
  'CLAUDE.md', 'design', 'docs', 'research', '.env', '.env.example',
  '.gitignore', '.skills', '.supertools-state',
];

// supertools-stack ships vitest configs, vitest test files and test:* scripts
// but declares no vitest dependency. Pinned here rather than floating so a
// re-scaffold is reproducible; matches the pin used by sibling projects.
const VITEST_RANGE = '^4.1.5';

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

// Resolve the stack source (see header for the order).
async function resolveStack() {
  for (const dir of STACK_CANDIDATES) {
    try {
      await fs.access(path.join(dir, 'install.sh'));
    } catch {
      continue;
    }
    const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf-8' }).stdout.trim();
    const sha = git('rev-parse', 'HEAD');
    const dirty = git('status', '--porcelain') !== '';
    const ahead = git('rev-list', '--count', 'origin/main..HEAD');
    const behind = git('rev-list', '--count', 'HEAD..origin/main');
    // Only flag a divergence when there actually is one — a synced checkout
    // is the normal case and should not emit a scary note.
    const diverged = (ahead && ahead !== '0') || (behind && behind !== '0');
    log(`  using local stack checkout at ${dir}`);
    return {
      source: 'local-checkout', path: dir, sha, dirty,
      divergence: diverged
        ? `local is ${ahead} ahead / ${behind} behind origin/main — reconcile before relying on this scaffold`
        : null,
    };
  }
  log('  (no local stack checkout found — cloning from GitHub)');
  const repo = await ensureRepo('supertools-stack');
  return { source: 'github-clone', path: repo.path, sha: repo.sha, dirty: false, divergence: null };
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
  // JSONC-tolerant: strip // line and /* block comments and trailing commas,
  // WITHOUT touching string literals. This function is read-only in intent —
  // its output is parsed, never written back — so comment loss here is fine.
  //
  // The trailing-comma pass must be string-aware. A previous version finished
  // with a bare `out.replace(/,(\s*[}\]])/g, '$1')`, which also rewrote string
  // CONTENT: a legitimate glob like "foo{bar,}" silently became "foo{bar}".
  // Because the splice guard re-parses through this same function, the guard
  // could not detect the corruption it was supposed to catch.
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
    } else if (c === ',') {
      // Look ahead past whitespace AND any comments still in the raw input for
      // a closing brace/bracket. Skipping only whitespace would leave a genuine
      // trailing comma behind in `[ "a", /* note */ ]`, since the comment is
      // stripped later in the same scan.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === '/' && text[j + 1] === '/') {
          while (j < text.length && text[j] !== '\n') j++;
        } else if (text[j] === '/' && text[j + 1] === '*') {
          j += 2;
          while (j < text.length - 1 && !(text[j] === '*' && text[j + 1] === '/')) j++;
          j += 2;
        } else break;
      }
      if (text[j] === '}' || text[j] === ']') { i++; continue; }
      out += c; i++;
    } else {
      out += c; i++;
    }
  }
  return out;
}

async function hardenTsConfig() {
  // The scaffold's tsconfig typechecks everything; exclude non-app folders.
  //
  // tsconfig.json is JSONC. An earlier version parsed it and reserialized with
  // JSON.stringify, which silently deleted the scaffold's section comments
  // (`/* Bundler mode */`, `/* Linting */`) and reflowed every inline array.
  // Authoring-checklist rule 12 forbids that: comments are documentation and a
  // wholesale rewrite counts as leaving the project worse. So the value is
  // still READ through the comment-stripper, but the write is a surgical,
  // line-anchored splice of the top-level `exclude` key only — every other
  // byte of the file is preserved verbatim.
  const tsPath = path.join(PROJECT_ROOT, 'tsconfig.json');
  let rawOnDisk;
  try { rawOnDisk = await fs.readFile(tsPath, 'utf-8'); }
  catch { log('  (no tsconfig.json; skipping ts harden)'); return; }
  // A UTF-8 BOM is legal in tsconfig.json and TypeScript accepts it, but it
  // defeats both JSON.parse and the "does the file start with {" check. Split
  // it off, operate on the body, and restore it byte-for-byte on write.
  const bom = rawOnDisk.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const raw = bom ? rawOnDisk.slice(1) : rawOnDisk;
  let cfg;
  try { cfg = JSON.parse(stripJsonComments(raw)); }
  catch (err) {
    // Never crash the whole scaffold on an unparseable tsconfig — say so and
    // leave the file untouched. Hardening is an optimisation, not a
    // correctness requirement.
    log(`  ! tsconfig.json is not parseable JSONC (${err.message}); leaving it untouched`);
    return;
  }
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

  // Locate a top-level `"exclude": [` that is NOT inside a comment or a string,
  // then APPEND the missing entries just before the array's closing bracket.
  //
  // Appending rather than replacing is deliberate. Replacing the whole array
  // (`\[[^\]]*\]` -> freshly serialized JSON) destroyed any comment written
  // INSIDE the array — e.g. `"exclude": [ /* generated */ "dist" ]` — which is
  // the same rule-12 violation as the JSON.stringify rewrite it replaced, just
  // narrower. Appending leaves every existing byte of the array untouched.
  // Advance past whitespace AND JSONC comments. Every structural walk below
  // uses this — skipping only whitespace meant a comment between the key, the
  // colon and the `[` made the scanner miss a perfectly valid exclude array.
  const skipTrivia = (text, idx) => {
    let j = idx;
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '/' && text[j + 1] === '/') {
        while (j < text.length && text[j] !== '\n') j++;
      } else if (text[j] === '/' && text[j + 1] === '*') {
        j += 2;
        while (j < text.length - 1 && !(text[j] === '*' && text[j + 1] === '/')) j++;
        j += 2;
      } else return j;
    }
  };

  const findExcludeArray = (text) => {
    let i = 0, inString = false, depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (inString) {
        if (c === '\\') { i += 2; continue; }
        if (c === '"') inString = false;
        i++; continue;
      }
      if (c === '"') {
        // Only a key at top level (depth 1) counts, so a nested "exclude"
        // inside compilerOptions or a string value can't match.
        if (depth === 1 && text.startsWith('"exclude"', i)) {
          let j = skipTrivia(text, i + '"exclude"'.length);
          if (text[j] === ':') {
            j = skipTrivia(text, j + 1);
            if (text[j] === '[') {
              // Walk to the matching close bracket, string- AND comment-aware.
              // A `]` inside a comment used to terminate the walk early, which
              // truncated the array and made the guard abort the whole run.
              let k = j + 1, inStr2 = false, bd = 1;
              while (k < text.length && bd > 0) {
                const d = text[k];
                if (inStr2) {
                  if (d === '\\') { k += 2; continue; }
                  if (d === '"') inStr2 = false;
                  k++; continue;
                }
                if (d === '"') { inStr2 = true; k++; continue; }
                if (d === '/' && text[k + 1] === '/') {
                  while (k < text.length && text[k] !== '\n') k++;
                  continue;
                }
                if (d === '/' && text[k + 1] === '*') {
                  k += 2;
                  while (k < text.length - 1 && !(text[k] === '*' && text[k + 1] === '/')) k++;
                  k += 2; continue;
                }
                if (d === '[') bd++;
                else if (d === ']') bd--;
                k++;
              }
              if (bd !== 0) return null;
              return { open: j, close: k - 1 };
            }
          }
        }
        inString = true; i++; continue;
      }
      if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2; continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      i++;
    }
    return null;
  };

  const loc = findExcludeArray(raw);
  let next;
  if (loc) {
    const interior = raw.slice(loc.open + 1, loc.close);
    // "Has entries" must ignore comments — `[ /* none yet */ ]` is an EMPTY
    // array and must not get a leading comma.
    const interiorSansComments = interior
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const hasEntries = /\S/.test(interiorSansComments);
    // Reuse the file's own indentation for the appended entries.
    const indentMatch = interior.match(/\n([ \t]+)\S/);
    const indent = indentMatch ? indentMatch[1] : '    ';
    const addition = added.map((a) => `${indent}${JSON.stringify(a)}`).join(',\n');
    // Keep the array interior verbatim (comments included); trim only its
    // trailing whitespace so the appended entries sit on fresh lines, and
    // reuse the closing bracket's own indentation.
    const closeIndentMatch = interior.match(/\n([ \t]*)$/);
    const closeIndent = closeIndentMatch ? closeIndentMatch[1] : '  ';

    // Find the end of the last real TOKEN in the array — not the last
    // character. Appending the separator to the end of the interior put the
    // comma after any trailing comment (`"dist" // note` -> `"dist" // note,`),
    // where the line comment swallowed it and the guard then rejected the file.
    // The comma has to be inserted immediately after the last value instead,
    // leaving trailing comments where the author put them.
    const lastTokenEnd = (text) => {
      let i = 0, end = -1, inStr = false;
      while (i < text.length) {
        const c = text[i];
        if (inStr) {
          if (c === '\\') { i += 2; continue; }
          if (c === '"') { inStr = false; end = i; }
          i++; continue;
        }
        if (c === '"') { inStr = true; i++; continue; }
        if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
        if (c === '/' && text[i + 1] === '*') {
          i += 2;
          while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
          i += 2; continue;
        }
        if (!/\s/.test(c)) end = i;
        i++;
      }
      return end;
    };

    const tokEnd = lastTokenEnd(interior);
    const needsComma = hasEntries && interior[tokEnd] !== ',';
    // head = everything through the last value (+ our comma if one is needed);
    // tail = whatever followed it (trailing comments), trailing blank space cut.
    const head = interior.slice(0, tokEnd + 1) + (needsComma ? ',' : '');
    const tail = interior.slice(tokEnd + 1).replace(/\s*$/, '');
    const interiorKept = hasEntries ? head + tail : interior.replace(/\s*$/, '');
    const sep = '\n';
    next =
      raw.slice(0, loc.open + 1) +
      interiorKept +
      sep +
      addition +
      '\n' + closeIndent +
      raw.slice(loc.close);
  } else {
    // No exclude key yet — insert one immediately after the opening brace so
    // the rest of the file, comments included, is untouched.
    // Find the opening brace past any leading comments — a file starting with
    // a banner comment is valid JSONC and `^\s*\{` failed on it.
    const block = `"exclude": ${JSON.stringify(merged, null, 2).replace(/\n/g, '\n  ')}`;
    const braceAt = skipTrivia(raw, 0);
    if (raw[braceAt] !== '{') {
      die('tsconfig.json does not start with an object; refusing to patch blindly.');
    }
    // If the object is non-empty the inserted key needs a trailing comma; if it
    // is empty (`{}`) a comma would be a syntax error.
    const afterBrace = skipTrivia(raw, braceAt + 1);
    const objectIsEmpty = raw[afterBrace] === '}';
    next =
      raw.slice(0, braceAt + 1) +
      `\n  ${block.replace(/\n/g, '\n  ')}${objectIsEmpty ? '\n' : ','}` +
      raw.slice(braceAt + 1);
  }

  // Prove the splice is safe before writing. Three independent guards, because
  // re-parsing through stripJsonComments alone cannot detect damage that the
  // stripper itself would also inflict on the original.
  //
  //  1. the result is valid JSONC and yields exactly the intended exclude array
  //  2. every OTHER top-level key is byte-for-byte unchanged in value
  //  3. no comment present in the original is missing from the result
  let reparsed;
  try { reparsed = JSON.parse(stripJsonComments(next)); }
  catch (err) { die(`tsconfig.json splice produced invalid JSONC: ${err.message}`); }
  if (JSON.stringify(reparsed.exclude) !== JSON.stringify(merged)) {
    die('tsconfig.json splice did not yield the intended exclude array; refusing to write.');
  }
  for (const key of Object.keys(cfg)) {
    if (key === 'exclude') continue;
    if (JSON.stringify(reparsed[key]) !== JSON.stringify(cfg[key])) {
      die(`tsconfig.json splice altered unrelated key "${key}"; refusing to write.`);
    }
  }
  const comments = (t) => {
    const found = [];
    let i = 0, inString = false;
    while (i < t.length) {
      const c = t[i];
      if (inString) {
        if (c === '\\') { i += 2; continue; }
        if (c === '"') inString = false;
        i++;
      } else if (c === '"') { inString = true; i++; }
      else if (c === '/' && t[i + 1] === '/') {
        const s = i; while (i < t.length && t[i] !== '\n') i++;
        found.push(t.slice(s, i).trim());
      } else if (c === '/' && t[i + 1] === '*') {
        const s = i; i += 2;
        while (i < t.length - 1 && !(t[i] === '*' && t[i + 1] === '/')) i++;
        i += 2; found.push(t.slice(s, i).trim());
      } else i++;
    }
    return found;
  };
  const lost = comments(raw).filter((c) => !comments(next).includes(c));
  if (lost.length) {
    die(`tsconfig.json splice dropped ${lost.length} comment(s): ${lost.join(' | ')}; refusing to write.`);
  }

  await fs.writeFile(tsPath, bom + next);
  log(`  patched tsconfig.json exclude (+${added.length}: ${added.join(', ')}) [appended in place; ${comments(raw).length} comment(s) preserved]`);
}

async function deliverScaffoldOnlyFiles(tmpProject) {
  // `.env.example` is on PRESERVED, so the rsync excludes it root-anchored.
  // That protects a project's own copy — but when the project has none, the
  // same exclude DROPS the scaffold's copy instead of delivering it, so the
  // file could never reach a fresh project and the verifier FAILed on
  // "preserved: .env.example missing". Copy it explicitly, never overwriting.
  const candidates = ['.env.example'];
  for (const rel of candidates) {
    const dest = path.join(PROJECT_ROOT, rel);
    try { await fs.access(dest); continue; } catch {}
    const src = path.join(tmpProject, rel);
    try { await fs.copyFile(src, dest); log(`  delivered scaffold-only file: ${rel}`); }
    catch { log(`  (scaffold ships no ${rel}; skipping)`); }
  }

  // `docs/` is a declared PRESERVED path, but neither this project nor the
  // scaffold necessarily has one, and the verifier asserts every PRESERVED
  // entry exists. Create the directory so the skill's own contract is
  // self-consistent rather than asserting a path it never provides.
  const docsDir = path.join(PROJECT_ROOT, 'docs');
  try { await fs.access(docsDir); }
  catch { await fs.mkdir(docsDir, { recursive: true }); log('  created docs/ (declared PRESERVED path)'); }
}

async function ensureTestTooling() {
  // The scaffold ships vitest.contract.config.ts, vitest.auth.config.ts and
  // test files importing from 'vitest', but supertools-stack does not declare
  // vitest as a dependency — so every test target failed "vitest: not found",
  // which also failed `tsc --noEmit` with TS2307 on the vitest module.
  //
  // SKILL.md also states that bare `npm test` is repointed at test:contract;
  // the scaffold ships no `test` script at all, so that documented contract
  // was false. Both are repaired here so a fresh scaffold is self-consistent.
  const pkgPath = path.join(PROJECT_ROOT, 'package.json');
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')); }
  catch { log('  (no package.json; skipping test tooling)'); return { changed: false }; }

  const scripts = pkg.scripts || {};
  const usesVitest = Object.values(scripts).some((s) => typeof s === 'string' && s.includes('vitest'));
  if (!usesVitest) return { changed: false };

  const notes = [];
  pkg.devDependencies = pkg.devDependencies || {};
  if (!pkg.devDependencies.vitest && !(pkg.dependencies || {}).vitest) {
    pkg.devDependencies.vitest = VITEST_RANGE;
    notes.push(`devDependencies.vitest=${VITEST_RANGE}`);
  }
  if (!scripts.test && scripts['test:contract']) {
    // SKILL.md: bare `npm test` is repointed at test:contract because the
    // scaffold's original `vitest run` breaks on the CF vite plugin's
    // resolve.external validation.
    scripts.test = 'npm run test:contract';
    pkg.scripts = scripts;
    notes.push('scripts.test -> test:contract');
  }
  if (notes.length === 0) {
    log('  test tooling already present (vitest + npm test)');
    return { changed: false };
  }
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  log(`  repaired test tooling (${notes.join(', ')})`);
  return { changed: true };
}

async function ensureAuthTestOrigin() {
  // The stack's signup-flow test POSTs with no Origin header. Better Auth
  // >=1.4 rejects that as CSRF with 403 MISSING_OR_NULL_ORIGIN, so both auth
  // tests fail on a fresh scaffold. This skill's failure-mode table has
  // documented the fix since 2026-07-03 with a note to upstream it; that never
  // happened, so repair it here rather than shipping a knowingly-broken test.
  const rel = 'tests/20-auth/signup-flow.test.ts';
  const p = path.join(PROJECT_ROOT, rel);
  let src;
  try { src = await fs.readFile(p, 'utf-8'); }
  catch { log(`  (no ${rel}; skipping auth-test repair)`); return false; }

  if (/Origin:\s*BASE/.test(src)) {
    log('  auth test already sends Origin');
    return false;
  }
  const headerRe = /headers:\s*\{\s*'Content-Type':\s*'application\/json'\s*\}/;
  if (!headerRe.test(src)) {
    // Do not guess at an unrecognized shape — say so instead of silently
    // leaving a test that will fail with a confusing 403.
    log(`  ! ${rel} headers not in the expected shape; leaving it alone (auth tests may 403)`);
    return false;
  }
  const next = src.replace(
    headerRe,
    "headers: { 'Content-Type': 'application/json', Origin: BASE }",
  );
  await fs.writeFile(p, next);
  log('  repaired auth test (added Origin header for Better Auth >=1.4 CSRF check)');
  return true;
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

  // Runs AFTER the integrity check, so it can never be confused with the merge
  // touching a preserved path. These deliver files the rsync excludes blocked.
  log('▶ Delivering scaffold-only files the preserved-excludes blocked...');
  await deliverScaffoldOnlyFiles(tmpProject);

  log('▶ Repairing test tooling...');
  const testTooling = await ensureTestTooling();
  const authTestRepaired = await ensureAuthTestOrigin();

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
    preservedHashedFiles: Object.entries(before)
      .filter(([, v]) => v.kind === 'file')
      .map(([k]) => k),
    preservedKindOnlyDirs: Object.entries(before)
      .filter(([, v]) => v.kind === 'dir')
      .map(([k]) => k),
    testToolingRepaired: testTooling.changed,
    authTestRepaired,
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
