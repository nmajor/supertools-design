#!/usr/bin/env node
// 02-design-tokens setup.
// Patches src/styles.css with the project's Google Fonts URL, @theme typography
// tokens, and the portable :root tokens from product-plan/design-system/tokens.css.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import {
  requireExport, TOKENS_CSS, fontFamilies, googleFontsUrl, familiesInUrl, parseTokens,
} from '../_shared/design-os.mjs';

const STATE_SUB   = path.join(PROJECT_ROOT, '.supertools-state', '02-design-tokens');
const STYLES_PATH = path.join(PROJECT_ROOT, 'src', 'styles.css');
const TOKENS_PATH = TOKENS_CSS;

const BEGIN_MARKER = '/* === supertools 02-design-tokens BEGIN === */';
const END_MARKER   = '/* === supertools 02-design-tokens END === */';

// Build Tailwind 4's `@theme` typography map from the project's own font
// stacks. Tailwind's utility names are fixed (font-sans / font-serif /
// font-mono), so the three design-system ROLES are bound to them:
//
//   --font-sans  ← the body face
//   --font-serif ← the heading/display face, whether or not it is a serif.
//                  The `font-serif` utility is what this pipeline's page
//                  templates use for headings, so the binding is by role.
//   --font-mono  ← the mono face
//
// A role the export does not define is simply omitted — Tailwind keeps its
// own default for it rather than inheriting another project's brand.
function buildThemeBlock(families) {
  const lines = [];
  if (families.body)    lines.push(`  --font-sans:  ${families.body};`);
  if (families.heading) lines.push(`  --font-serif: ${families.heading};`);
  if (families.mono)    lines.push(`  --font-mono:  ${families.mono};`);
  return `@theme {\n${lines.join('\n')}\n}`;
}

// Typography comes from the Design OS export, never from a literal here.
// Fonts: design-system/fonts.json { "url": … } → the Google Fonts <link> in
// design-system/fonts.md → none. Families: tokens.css --font-* → the fonts.md
// role table. If the export declares no webfont sheet, none is written; the
// scaffold's own @import is removed rather than replaced with someone else's.
function resolveFonts() {
  const families = fontFamilies();
  if (!families.heading && !families.body && !families.mono) {
    die(
      `No font stacks found in the Design OS export.\n` +
      `  Expected --font-heading / --font-body / --font-mono in ${TOKENS_PATH},\n` +
      `  or a "Font usage" role table in design-system/fonts.md.\n` +
      `  Re-run Design OS's /design-tokens step.`
    );
  }
  const { url, source } = googleFontsUrl();
  return { fontsUrl: url, fontsUrlSource: source, families, theme: buildThemeBlock(families) };
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

  try { requireExport(); } catch (e) { die(e.message); }

  const { fontsUrl, fontsUrlSource, families, theme } = resolveFonts();
  log(`▶ Font stacks from ${families.source}`);
  log(`▶ Webfont sheet from ${fontsUrlSource}`);

  let styles;
  try { styles = await fs.readFile(STYLES_PATH, 'utf-8'); }
  catch { die(`src/styles.css not found at ${STYLES_PATH}`); }

  await fs.writeFile(path.join(STATE_SUB, 'styles.css.before.txt'), styles);
  log(`▶ Snapshotted original src/styles.css (${styles.length} bytes)`);

  let next = styles;
  const actions = [];

  // 1. Point the Google Fonts @import at the export's sheet. If the design
  //    system declares no webfonts, the scaffold's own @import is DELETED
  //    rather than left in place — shipping another project's fonts is worse
  //    than shipping none.
  const fontsImportRe = /@import\s+url\("https:\/\/fonts\.googleapis\.com[^"]*"\)\s*;?\n?/g;
  if (fontsUrl) {
    const fontsLine = `@import url("${fontsUrl}");`;
    if (fontsImportRe.test(next)) {
      next = next.replace(fontsImportRe, fontsLine + '\n');
      actions.push('replaced existing Google Fonts @import');
    } else {
      next = fontsLine + '\n' + next;
      actions.push('prepended Google Fonts @import');
    }
  } else if (fontsImportRe.test(next)) {
    next = next.replace(fontsImportRe, '');
    actions.push('removed the scaffold Google Fonts @import (export declares no webfonts)');
  } else {
    actions.push('no Google Fonts @import (export declares no webfonts)');
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
    designOsExport: {
      tokensCss: TOKENS_PATH,
      fontStacksFrom: families.source,
      webfontSheetFrom: fontsUrlSource,
    },
    fontsUrl,
    // Derived from what was actually written, not assumed.
    webfontFamilies: familiesInUrl(fontsUrl),
    fontRoles: { heading: families.heading, body: families.body, mono: families.mono },
    tokensDeclared: [...parseTokens(tokens).keys()],
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
