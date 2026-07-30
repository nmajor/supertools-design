#!/usr/bin/env node
// 03-shell verifier.
// Checks shell files in place, demo files gone, radix dep installed, root.tsx
// wired, styles.css cleaned, build+tsc green, and the rendered HTML actually
// contains the project wordmark.

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';
import { parseTokens, readTokensCss, shellComponentFiles } from '../_shared/design-os.mjs';

const BRAND = readProject().brandName;

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function probeUrl(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return { status: r.status, html: await r.text() };
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function killGroup(pid) {
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}

// Scan the whole project, not just src/ — a route, a script or a config file
// outside src/ can import a component just as well, and deleting something
// they use breaks the build all the same.
const SCAN_SKIP = new Set(['node_modules', '.git', '.wrangler', '.output', '.tanstack', 'dist', 'design', '.skills', '.supertools-state']);
async function sourceFilesUnder(dir, acc = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (SCAN_SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await sourceFilesUnder(p, acc);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

async function main() {
  loadEnv();

  // Whatever the export ships must have landed — not a fixed list. The
  // reference implementation had a Footer component; other projects do not,
  // and demanding one made this verifier fail on a perfectly good export.
  let shellFiles = [];
  try {
    shellFiles = shellComponentFiles();
    pass('shell components declared by the export', shellFiles.join(', '));
  } catch (e) {
    fail('shell components declared by the export', e.message);
  }
  for (const f of shellFiles) {
    (await exists(path.join(PROJECT_ROOT, 'src/components/shell', f)))
      ? pass(`shell: ${f}`) : fail(`shell: ${f}`, 'missing');
  }

  // A scaffold demo component must be EITHER removed OR still referenced by
  // something. Asserting unconditional removal was wrong: Footer.tsx is app
  // chrome the export's shell replaces, but it is also imported by the
  // scaffold's marketing layout, and deleting it broke the build with
  // "Cannot find module '../../components/Footer'". What matters is that the
  // project is left consistent, not that a particular file is gone.
  const srcFiles = await sourceFilesUnder(PROJECT_ROOT);
  for (const f of ['Header.tsx', 'Footer.tsx', 'ThemeToggle.tsx']) {
    const p = path.join(PROJECT_ROOT, 'src/components', f);
    if (!await exists(p)) { pass(`scaffold demo resolved: ${f} removed`); continue; }

    const base = f.replace(/\.(tsx?|jsx?)$/, '');
    const importRe = new RegExp(`from\\s+['"][^'"]*/(?:components/)?${base}['"]`);
    const referrers = [];
    for (const sf of srcFiles) {
      if (sf === p) continue;
      if (importRe.test(await fs.readFile(sf, 'utf-8'))) {
        referrers.push(path.relative(PROJECT_ROOT, sf));
      }
    }
    referrers.length
      ? pass(`scaffold demo resolved: ${f} kept — still imported by ${referrers.join(', ')}`)
      : fail(`scaffold demo resolved: ${f}`, 'still present and nothing imports it');
  }

  // Assert that every external package the COPIED files import is declared —
  // not that one named package is present.
  //
  // This used to require @radix-ui/react-dropdown-menu unconditionally, which
  // was wrong twice over: setup now installs whatever the export imports, so a
  // project that never imports Radix would fail for no reason; and here it
  // PASSED only because a stale entry sat in package.json from the old
  // hardcoded-install behaviour, while the export imports no Radix at all.
  // A check that passes on a stale artifact is worse than no check.
  const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  {
    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ]);
    const req = createRequire(path.join(PROJECT_ROOT, 'noop.js'));
    let ts;
    try { ts = req('typescript'); } catch { ts = null; }

    if (!ts) {
      fail('external imports of the copied shell are declared', 'typescript not resolvable from the project');
    } else {
      const copied = [];
      for (const f of shellFiles) copied.push(path.join(PROJECT_ROOT, 'src/components/shell', f));
      const kitDir = path.join(PROJECT_ROOT, 'src', 'kit');
      try {
        for (const f of await fs.readdir(kitDir)) {
          if (/\.(ts|tsx)$/.test(f)) copied.push(path.join(kitDir, f));
        }
      } catch { /* export ships no kit */ }

      const needed = new Set();
      for (const abs of copied) {
        let src;
        try { src = await fs.readFile(abs, 'utf-8'); } catch { continue; }
        const pre = ts.preProcessFile(src, true, true);
        for (const f of pre.importedFiles || []) {
          const spec = f.fileName;
          if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') ||
              spec.startsWith('#/') || spec.includes(':')) continue;
          const parts = spec.split('/');
          needed.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
        }
      }
      const missing = [...needed].filter((n) => !declared.has(n)).sort();
      missing.length === 0
        ? pass('external imports of the copied shell are declared',
               needed.size ? [...needed].sort().join(', ') : 'the export imports no external packages')
        : fail('external imports of the copied shell are declared', `undeclared: ${missing.join(', ')}`);
    }
  }

  const rootTsx = await fs.readFile(path.join(PROJECT_ROOT, 'src/routes/__root.tsx'), 'utf-8');
  /from\s+['"]\.\.\/components\/shell['"]/.test(rootTsx)
    ? pass('__root.tsx imports AppShell')
    : fail('__root.tsx imports AppShell', 'import missing');
  /\buseNavigate\b/.test(rootTsx)
    ? pass('__root.tsx uses useNavigate')
    : fail('__root.tsx uses useNavigate', 'not wired');

  const css = await fs.readFile(path.join(PROJECT_ROOT, 'src/styles.css'), 'utf-8');
  !/--sea-ink|--lagoon|island-shell|island-kicker|\.feature-card|\.nav-link\b/.test(css)
    ? pass('styles.css clean of lagoon/sea demo')
    : fail('styles.css clean of lagoon/sea demo', 'demo selectors still present');

  // The rewrite must not have dropped skill 02's work. Checked against the
  // project's own export rather than a named colour — this used to assert
  // a specific brand colour, which no non-reference project ever has.
  {
    const exportTokens = parseTokens(readTokensCss());
    const shipped = parseTokens(css);
    const lost = [...exportTokens.keys()].filter((k) => !shipped.has(k));
    exportTokens.size && !lost.length
      ? pass('styles.css preserves skill 02 tokens', `${exportTokens.size} custom properties intact`)
      : fail('styles.css preserves skill 02 tokens',
          exportTokens.size ? `dropped by the rewrite: ${lost.join(', ')}` : 'the export declares no tokens');
  }
  /@theme\s*\{[\s\S]*?\}/.test(css)
    ? pass('styles.css preserves skill 02 @theme typography')
    : fail('styles.css preserves skill 02 @theme typography', '@theme block missing after the rewrite');

  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  build.status === 0
    ? pass('npm run build')
    : fail('npm run build', (build.stderr || build.stdout || '').slice(-1500));

  const tsc = spawnSync('npx', ['tsc', '--noEmit'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  tsc.status === 0
    ? pass('tsc --noEmit')
    : fail('tsc --noEmit', (tsc.stderr || tsc.stdout || '').slice(-1500));

  const port = await pickFreePort();
  const viteBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'vite');
  const vite = spawn(viteBin, ['dev', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: PROJECT_ROOT, detached: true, stdio: 'ignore',
  });
  try {
    const res = await probeUrl(`http://127.0.0.1:${port}/`, 60000);
    if (!res) {
      fail('vite dev GET /', 'no 2xx within 60s');
    } else {
      pass('vite dev GET /', `HTTP ${res.status} on port ${port}`);
      // The shell renders this project's brand. Anything more specific than
      // that — a particular footer pill, a particular tagline — belongs to
      // whoever designed the shell, not to this skill.
      //
      // Search the BODY only. Searching the whole document made this check
      // vacuous: __root.tsx puts the brand in <title>, so the assertion passed
      // whether or not the shell rendered anything at all.
      const bodyMatch = res.html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const body = bodyMatch ? bodyMatch[1] : '';
      const brandRe = new RegExp(BRAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (!bodyMatch) {
        fail(`rendered body contains the ${BRAND} wordmark`, 'no <body> in the response');
      } else if (brandRe.test(body)) {
        pass(`rendered body contains the ${BRAND} wordmark`);
      } else {
        fail(
          `rendered body contains the ${BRAND} wordmark`,
          `not found in ${body.length} bytes of <body> (present in <head>: ${brandRe.test(res.html.slice(0, res.html.indexOf('<body')))})`,
        );
      }
    }
  } finally {
    if (vite.pid) await killGroup(vite.pid);
  }

  let okCount = 0;
  for (const c of checks) {
    const mark = c.ok ? 'OK ' : 'FAIL';
    const tail = c.detail ? ' — ' + c.detail.split('\n').slice(0, 2).join(' / ') : '';
    console.log(`[${mark}] ${c.name}${tail}`);
    if (c.ok) okCount++;
  }
  console.log(`\n${okCount}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
