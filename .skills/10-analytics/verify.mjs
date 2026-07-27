#!/usr/bin/env node
// 10-analytics verifier.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };

async function main() {
  loadEnv();
  requireEnv(['RYBBIT_HOST', 'RYBBIT_SITE_ID']);
  const host = (process.env.RYBBIT_HOST || '').replace(/\/+$/, '');
  const siteId = String(process.env.RYBBIT_SITE_ID);

  /^\d+$/.test(siteId) ? pass('RYBBIT_SITE_ID is numeric', siteId) : fail('RYBBIT_SITE_ID is numeric', `got "${siteId}"`);

  // script embedded in __root.tsx with correct host + data-site-id
  const root = await fs.readFile(path.join(PROJECT_ROOT, 'src/routes/__root.tsx'), 'utf-8');
  root.includes('supertools-analytics') ? pass('analytics marker in __root.tsx') : fail('analytics marker in __root.tsx', 'missing');
  const tagRe = new RegExp(`<script[^>]*src="${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/script\\.js"[^>]*data-site-id="${siteId}"[^>]*>`);
  tagRe.test(root) ? pass('script tag has correct host + site-id') : fail('script tag has correct host + site-id', 'tag missing or mismatched');

  // analytics taxonomy module
  const an = await fs.readFile(path.join(PROJECT_ROOT, 'src/lib/analytics.ts'), 'utf-8').catch(() => '');
  /export function track\(/.test(an) ? pass('analytics.ts exports track()') : fail('analytics.ts exports track()', 'missing');
  /export const AnalyticsEvent/.test(an) ? pass('analytics.ts exports AnalyticsEvent') : fail('analytics.ts exports AnalyticsEvent', 'missing');
  /window\.rybbit/.test(an) ? pass('track() targets window.rybbit') : fail('track() targets window.rybbit', 'missing');

  // build + tsc
  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  build.status === 0 ? pass('npm run build') : fail('npm run build', (build.stderr || build.stdout || '').slice(-800));
  const tsc = spawnSync('npx', ['tsc', '--noEmit'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  tsc.status === 0 ? pass('tsc --noEmit') : fail('tsc --noEmit', (tsc.stderr || tsc.stdout || '').slice(-800));

  let okC = 0;
  for (const c of checks) { console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`); if (c.ok) okC++; }
  console.log(`\n${okC}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
