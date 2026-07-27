#!/usr/bin/env node
// 02-design-tokens setup.
// Patches src/styles.css with the project's Google Fonts URL, @theme typography
// tokens, and the portable :root tokens from product-plan/design-system/tokens.css.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';

const STATE_SUB   = path.join(PROJECT_ROOT, '.supertools-state', '02-design-tokens');
const STYLES_PATH = path.join(PROJECT_ROOT, 'src', 'styles.css');
const TOKENS_PATH = path.join(PROJECT_ROOT, 'design', 'product-plan', 'design-system', 'tokens.css');

// Typography defaults. The portable :root color tokens come from the Design OS
// export (TOKENS_PATH); the type stack does not, so these are the fallback.
// Override per project with design/product-plan/design-system/fonts.json:
//   { "url": "https://fonts.googleapis.com/css2?...", "theme": "@theme { ... }" }
// The values below are the reference implementation's (Fraunces / DM Sans /
// IBM Plex Mono) — replace them for your own brand.
const DEFAULT_FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@' +
  '0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;' +
  '1,9..144,500;1,9..144,600;1,9..144,700' +
  '&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700' +
  '&family=IBM+Plex+Mono:wght@400;500&display=swap';

const DEFAULT_THEME = `@theme {
  --font-sans:  "DM Sans", ui-sans-serif, system-ui, sans-serif;
  --font-serif: "Fraunces", Georgia, serif;
  --font-mono:  "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}`;

const BEGIN_MARKER = '/* === supertools 02-design-tokens BEGIN === */';
const END_MARKER   = '/* === supertools 02-design-tokens END === */';

const FONTS_OVERRIDE_PATH = path.join(
  PROJECT_ROOT, 'design', 'product-plan', 'design-system', 'fonts.json'
);

// Per-project typography override, if the Design OS export supplies one.
async function resolveFonts() {
  try {
    const j = JSON.parse(await fs.readFile(FONTS_OVERRIDE_PATH, 'utf-8'));
    return {
      fontsUrl: j.url || DEFAULT_FONTS_URL,
      theme: j.theme || DEFAULT_THEME,
      source: 'product-plan/design-system/fonts.json',
    };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { fontsUrl: DEFAULT_FONTS_URL, theme: DEFAULT_THEME, source: 'defaults' };
  }
}

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function main() {
  loadEnv();
  await fs.mkdir(STATE_SUB, { recursive: true });

  const prior = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', '01-project-init.json'), 'utf-8')
  );
  if (prior.status !== 'ok') die('01-project-init not ok; halting');

  const { fontsUrl, theme, source: fontsSource } = await resolveFonts();
  log(`▶ Typography from ${fontsSource}`);

  let styles;
  try { styles = await fs.readFile(STYLES_PATH, 'utf-8'); }
  catch { die(`src/styles.css not found at ${STYLES_PATH}`); }

  await fs.writeFile(path.join(STATE_SUB, 'styles.css.before.txt'), styles);
  log(`▶ Snapshotted original src/styles.css (${styles.length} bytes)`);

  let next = styles;
  const actions = [];

  // 1. Replace any existing fonts.googleapis.com @import
  const fontsImportRe = /@import\s+url\("https:\/\/fonts\.googleapis\.com[^"]*"\)\s*;?/g;
  const fontsLine = `@import url("${fontsUrl}");`;
  if (fontsImportRe.test(next)) {
    next = next.replace(fontsImportRe, fontsLine);
    actions.push('replaced existing Google Fonts @import');
  } else {
    next = fontsLine + '\n' + next;
    actions.push('prepended Google Fonts @import');
  }

  // 2. Replace the @theme block (assumes one top-level @theme — true for the C3 scaffold)
  const themeRe = /@theme\s*\{[\s\S]*?\}/;
  if (themeRe.test(next)) {
    next = next.replace(themeRe, theme);
    actions.push('replaced existing @theme block');
  } else {
    next = next.replace(/(@import\s+"tailwindcss";\s*\n?)/, `$1\n${theme}\n\n`);
    actions.push('inserted @theme block');
  }

  // 3. Append (or replace) the marked tokens block at the bottom
  const tokens = await fs.readFile(TOKENS_PATH, 'utf-8');
  const markedBlock = `${BEGIN_MARKER}\n${tokens.trim()}\n${END_MARKER}\n`;
  const markerRe = new RegExp(
    `\\n?${escapeRegex(BEGIN_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}\\n?`
  );
  if (markerRe.test(next)) {
    next = next.replace(markerRe, '\n' + markedBlock);
    actions.push('replaced existing design-tokens block');
  } else {
    next = next.trimEnd() + '\n\n' + markedBlock;
    actions.push('appended design-tokens block');
  }

  await fs.writeFile(STYLES_PATH, next);
  log(`✓ wrote src/styles.css (${next.length} bytes)`);
  for (const a of actions) log(`  • ${a}`);

  const summary = {
    stylesPath: STYLES_PATH,
    bytesBefore: styles.length,
    bytesAfter: next.length,
    fontsUrl,
    fontsSource,
    // Derived from what was actually written, not assumed.
    fontFamilies: [...new Set([...fontsUrl.matchAll(/family=([^:&]+)/g)]
      .map((m) => decodeURIComponent(m[1]).replace(/\+/g, ' ')))],
    actions,
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(STATE_SUB, 'patch-summary.json'),
    JSON.stringify(summary, null, 2) + '\n'
  );

  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
