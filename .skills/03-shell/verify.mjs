#!/usr/bin/env node
// 03-shell verifier.
// Checks shell files in place, demo files gone, radix dep installed, root.tsx
// wired, styles.css cleaned, build+tsc green, and the rendered HTML actually
// contains the project wordmark + "Made with AI" footer pill.

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';

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

async function main() {
  loadEnv();

  for (const f of ['AppShell.tsx', 'MainNav.tsx', 'Footer.tsx', 'UserMenu.tsx', 'index.ts']) {
    (await exists(path.join(PROJECT_ROOT, 'src/components/shell', f)))
      ? pass(`shell: ${f}`) : fail(`shell: ${f}`, 'missing');
  }

  for (const f of ['Header.tsx', 'Footer.tsx', 'ThemeToggle.tsx']) {
    (!await exists(path.join(PROJECT_ROOT, 'src/components', f)))
      ? pass(`removed: src/components/${f}`)
      : fail(`removed: src/components/${f}`, 'still present');
  }

  const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  pkg.dependencies?.['@radix-ui/react-dropdown-menu']
    ? pass('dep: @radix-ui/react-dropdown-menu')
    : fail('dep: @radix-ui/react-dropdown-menu', 'not in dependencies');

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
  /--color-primary-900:\s*#881337/.test(css)
    ? pass('styles.css preserves skill 02 tokens')
    : fail('styles.css preserves skill 02 tokens', 'rose tokens missing');

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
      new RegExp(BRAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(res.html)
        ? pass(`HTML contains the ${BRAND} wordmark`)
        : fail(`HTML contains the ${BRAND} wordmark`, `not found in ${res.html.length} bytes`);
      /Made with AI/.test(res.html)
        ? pass('HTML contains "Made with AI" pill')
        : fail('HTML contains "Made with AI" pill', 'not found');
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
