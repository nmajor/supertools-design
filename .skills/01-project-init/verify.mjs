#!/usr/bin/env node
// 01-project-init verifier.
// Confirms the merged project boots end-to-end and preserved files survived.
// All check names/details pass through the shared redactor before storage.

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../_shared/env.mjs';
import { buildRedactor } from '../_shared/redact.mjs';
import { PRESERVED } from './setup.mjs';

const { redact } = buildRedactor([]);
const checks = [];
const fail = (n, d = '') => { checks.push({ name: redact(n), ok: false, detail: redact(d) }); };
const pass = (n, d = '') => { checks.push({ name: redact(n), ok: true, detail: redact(d) }); };

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function probeUrl(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.status;
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
  // 1. Preserved files (same list setup.mjs protects; .env checked without
  //    ever reading it)
  for (const p of PRESERVED) {
    (await exists(path.join(PROJECT_ROOT, p)))
      ? pass(`preserved: ${p}`) : fail(`preserved: ${p}`, 'missing');
  }

  // 2. Scaffold files
  for (const p of ['package.json', 'wrangler.jsonc', 'tsconfig.json', 'vite.config.ts', 'src']) {
    (await exists(path.join(PROJECT_ROOT, p)))
      ? pass(`scaffold: ${p}`) : fail(`scaffold: ${p}`, 'missing');
  }

  // 3. node_modules
  (await exists(path.join(PROJECT_ROOT, 'node_modules')))
    ? pass('node_modules') : fail('node_modules', 'npm install did not run');

  // 4. .git present
  (await exists(path.join(PROJECT_ROOT, '.git')))
    ? pass('.git present') : fail('.git present', 'repo should already be initialized');

  // 5. .env in .gitignore
  let gi = '';
  try { gi = await fs.readFile(path.join(PROJECT_ROOT, '.gitignore'), 'utf-8'); } catch {}
  gi.split('\n').some((l) => l.trim() === '.env')
    ? pass('.env in .gitignore')
    : fail('.env in .gitignore', 'critical — add `.env` to .gitignore before any git operation');

  // 6. npm run build
  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 });
  build.status === 0
    ? pass('npm run build')
    : fail('npm run build', (build.stderr || build.stdout || '').slice(-1500));

  // 7. tsc --noEmit (after build so routeTree.gen.ts exists)
  const tsc = spawnSync('npx', ['tsc', '--noEmit'], { cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 });
  tsc.status === 0
    ? pass('tsc --noEmit')
    : fail('tsc --noEmit', (tsc.stderr || tsc.stdout || '').slice(-1500));

  // 8. Contract suite (self-contained; also what bare `npm test` runs —
  //    the scaffold's original `vitest run` breaks on the CF vite plugin's
  //    resolve.external validation, so `test` points at test:contract)
  const contract = spawnSync('npm', ['run', 'test:contract'], { cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 });
  contract.status === 0
    ? pass('npm run test:contract')
    : fail('npm run test:contract', (contract.stderr || contract.stdout || '').slice(-1500));

  // 9. Local D1 migrations (idempotent; the auth suite needs the tables)
  const migrate = spawnSync('npm', ['run', 'db:migrate:local'], { cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 });
  migrate.status === 0
    ? pass('db:migrate:local')
    : fail('db:migrate:local', (migrate.stderr || migrate.stdout || '').slice(-1500));

  // 10. Live dev server: GET / probe + the auth signup-flow suite against it
  //     (IPv4 binding so the 127.0.0.1 probe matches; stdio ignored so a full
  //     output buffer can't block vite startup)
  const port = await pickFreePort();
  const base = `http://127.0.0.1:${port}`;
  const viteBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'vite');
  const vite = spawn(viteBin, ['dev', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: PROJECT_ROOT, detached: true, stdio: 'ignore',
  });
  try {
    const code = await probeUrl(`${base}/`, 60000);
    code
      ? pass('vite dev GET /', `HTTP ${code} on port ${port}`)
      : fail('vite dev GET /', 'no 2xx within 60s');

    if (code) {
      const auth = spawnSync('npm', ['run', 'test:auth'], {
        cwd: PROJECT_ROOT, encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024,
        env: { ...process.env, BETTER_AUTH_TEST_BASE_URL: base },
      });
      auth.status === 0
        ? pass('test:auth (live signup flow)')
        : fail('test:auth (live signup flow)', (auth.stderr || auth.stdout || '').slice(-1500));
    } else {
      fail('test:auth (live signup flow)', 'skipped — dev server never answered');
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

main().catch((e) => { console.error(redact(e.stack || e.message)); process.exit(2); });
