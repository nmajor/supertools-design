#!/usr/bin/env node
// 02-design-tokens verifier.
// Confirms src/styles.css carries the design-token fonts + @theme typography +
// portable :root tokens, then runs npm run build to catch any CSS errors.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';

const STYLES_PATH = path.join(PROJECT_ROOT, 'src', 'styles.css');

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };

async function main() {
  loadEnv();
  const css = await fs.readFile(STYLES_PATH, 'utf-8');

  // Google Fonts URL has all three families with the right axes
  /Fraunces:ital,opsz,wght/.test(css)
    ? pass('Fraunces (italic + opsz + weights)') : fail('Fraunces (italic + opsz + weights)', 'missing axes');
  /DM\+Sans:opsz/.test(css)
    ? pass('DM Sans') : fail('DM Sans', 'missing @import');
  /IBM\+Plex\+Mono:wght/.test(css)
    ? pass('IBM Plex Mono') : fail('IBM Plex Mono', 'missing @import');

  // @theme block maps Tailwind 4 typography utilities
  const themeMatch = css.match(/@theme\s*\{([\s\S]*?)\}/);
  if (!themeMatch) {
    fail('@theme block', 'missing');
  } else {
    const body = themeMatch[1];
    /--font-sans:\s*"DM Sans"/.test(body)
      ? pass('@theme font-sans → DM Sans') : fail('@theme font-sans → DM Sans', 'wrong or missing');
    /--font-serif:\s*"Fraunces"/.test(body)
      ? pass('@theme font-serif → Fraunces') : fail('@theme font-serif → Fraunces', 'wrong or missing');
    /--font-mono:\s*"IBM Plex Mono"/.test(body)
      ? pass('@theme font-mono → IBM Plex Mono') : fail('@theme font-mono → IBM Plex Mono', 'wrong or missing');
  }

  // Portable :root tokens appended from product-plan/design-system/tokens.css
  /--color-primary-900:\s*#881337/.test(css)
    ? pass('token --color-primary-900 (rose)') : fail('token --color-primary-900 (rose)', 'missing');
  /--color-secondary-700:\s*#047857/.test(css)
    ? pass('token --color-secondary-700 (emerald)') : fail('token --color-secondary-700 (emerald)', 'missing');
  /--color-neutral-900:\s*#1c1917/.test(css)
    ? pass('token --color-neutral-900 (stone)') : fail('token --color-neutral-900 (stone)', 'missing');
  /--font-heading:\s*"Fraunces"/.test(css)
    ? pass('token --font-heading') : fail('token --font-heading', 'missing');
  /--font-heading-display-settings:\s*'"opsz" 96'/.test(css)
    ? pass('token --font-heading-display-settings (opsz 96)') : fail('token --font-heading-display-settings (opsz 96)', 'missing');

  // Markers (idempotency)
  /=== supertools 02-design-tokens BEGIN ===/.test(css)
    ? pass('begin marker present') : fail('begin marker present', 'missing — re-runs won\'t be idempotent');
  /=== supertools 02-design-tokens END ===/.test(css)
    ? pass('end marker present') : fail('end marker present', 'missing');

  // Build still works
  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  build.status === 0
    ? pass('npm run build')
    : fail('npm run build', (build.stderr || build.stdout || '').slice(-1500));

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
