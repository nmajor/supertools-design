#!/usr/bin/env node
// 02-design-tokens verifier.
//
// Asserts that src/styles.css agrees with THIS PROJECT'S Design OS export —
// every custom property tokens.css declares is present with the same value,
// the @theme typography map matches the export's font roles, and the webfont
// @import matches the export's sheet. It names no font and no colour of its
// own: an earlier version asserted the reference implementation's Fraunces /
// rose / emerald / stone literals, which meant verification failed for every
// project that was not that one brand.
//
// Then runs npm run build to catch any CSS the patch broke.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import {
  checkExport, EXPORT_DIR, parseTokens, readTokensCss, fontFamilies, googleFontsUrl,
} from '../_shared/design-os.mjs';

const STYLES_PATH = path.join(PROJECT_ROOT, 'src', 'styles.css');

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };

// Whitespace inside a CSS value is not semantic — `'Inter', system-ui` and
// `'Inter',  system-ui` are the same declaration. Compare on a normal form.
const norm = (v) => String(v).replace(/\s+/g, ' ').trim();

function report() {
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

async function main() {
  loadEnv();

  const x = checkExport();
  if (!x.ok) {
    fail('design os export', `missing under ${EXPORT_DIR}: ${x.missing.join(', ')}`);
    return report();
  }
  pass('design os export', EXPORT_DIR);

  const css = await fs.readFile(STYLES_PATH, 'utf-8');

  // 1. Idempotency markers, and the block they delimit.
  const blockMatch = css.match(
    /\/\* === supertools 02-design-tokens BEGIN === \*\/([\s\S]*?)\/\* === supertools 02-design-tokens END === \*\//
  );
  blockMatch
    ? pass('design-tokens block markers', `${blockMatch[1].length} bytes between markers`)
    : fail('design-tokens block markers', 'BEGIN/END markers missing — re-runs will not be idempotent');

  // 2. Every custom property the export declares is present in styles.css with
  //    the SAME value. This is the substantive check: exactly as strict as the
  //    project's own design system, and silent about what those tokens are.
  const exportTokens = parseTokens(readTokensCss());
  const shippedTokens = parseTokens(blockMatch ? blockMatch[1] : css);
  if (exportTokens.size === 0) {
    fail('tokens.css declarations', 'the export declares no custom properties');
  } else {
    const missing = [];
    const wrong = [];
    for (const [name, value] of exportTokens) {
      if (!shippedTokens.has(name)) { missing.push(name); continue; }
      if (norm(shippedTokens.get(name)) !== norm(value)) {
        wrong.push(`${name} (export ${norm(value)} ≠ shipped ${norm(shippedTokens.get(name))})`);
      }
    }
    (missing.length || wrong.length)
      ? fail('tokens match the Design OS export',
          [missing.length ? `missing: ${missing.join(', ')}` : '',
           wrong.length ? `differing: ${wrong.join('; ')}` : ''].filter(Boolean).join(' | '))
      : pass('tokens match the Design OS export',
          `${exportTokens.size} custom properties, values identical`);
  }

  // 3. The @theme map binds Tailwind's typography utilities to the export's
  //    font roles: font-sans → body, font-serif → heading/display, font-mono → mono.
  const themeMatch = css.match(/@theme\s*\{([\s\S]*?)\}/);
  const families = fontFamilies();
  if (!themeMatch) {
    fail('@theme block', 'missing');
  } else {
    const themeTokens = parseTokens(themeMatch[1]);
    const bindings = [
      ['--font-sans', families.body, 'body'],
      ['--font-serif', families.heading, 'heading/display'],
      ['--font-mono', families.mono, 'mono'],
    ];
    for (const [prop, expected, role] of bindings) {
      if (!expected) {
        // A role the export does not define must NOT be invented here.
        themeTokens.has(prop)
          ? fail(`@theme ${prop}`, `set to "${themeTokens.get(prop)}" but the export defines no ${role} face`)
          : pass(`@theme ${prop}`, `absent — the export defines no ${role} face`);
        continue;
      }
      if (!themeTokens.has(prop)) { fail(`@theme ${prop} → ${role}`, 'missing'); continue; }
      norm(themeTokens.get(prop)) === norm(expected)
        ? pass(`@theme ${prop} → ${role}`, norm(expected))
        : fail(`@theme ${prop} → ${role}`, `expected ${norm(expected)}, got ${norm(themeTokens.get(prop))}`);
    }
  }

  // 4. The webfont sheet is the export's, or absent if the export declares none.
  const { url: expectedUrl, source: urlSource } = googleFontsUrl();
  const importMatch = css.match(/@import\s+url\("(https:\/\/fonts\.googleapis\.com[^"]*)"\)/);
  if (expectedUrl) {
    if (!importMatch) {
      fail('webfont @import', `missing — the export (${urlSource}) declares a Google Fonts sheet`);
    } else if (importMatch[1] !== expectedUrl) {
      fail('webfont @import', `does not match the export's sheet — export: ${expectedUrl} / styles: ${importMatch[1]}`);
    } else {
      pass('webfont @import', `matches ${urlSource}`);
    }
  } else {
    importMatch
      ? fail('webfont @import', `styles.css imports ${importMatch[1]} but the export declares no webfonts`)
      : pass('webfont @import', 'none, as the export declares none');
  }

  // 5. Build still works.
  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  build.status === 0
    ? pass('npm run build')
    : fail('npm run build', (build.stderr || build.stdout || '').slice(-1500));

  report();
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
