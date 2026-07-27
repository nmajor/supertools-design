#!/usr/bin/env node
// 04-logo setup.
// Generate the brand SVG wordmark + favicon set; patch __root.tsx head.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';

const BRAND_NAME = readProject().brandName;

const STATE_SUB   = path.join(PROJECT_ROOT, '.supertools-state', '04-logo');
const SVG_DUMP    = path.join(STATE_SUB, 'svg-sources');
const FONT_CACHE  = path.join(PROJECT_ROOT, '.supertools-state', '_cache', 'fonts');
const PUBLIC_DIR  = path.join(PROJECT_ROOT, 'public');
const ROOT_TSX    = path.join(PROJECT_ROOT, 'src', 'routes', '__root.tsx');
const PKG_JSON    = path.join(PROJECT_ROOT, 'package.json');

const SKILL_DIR    = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE  = path.join(SKILL_DIR, 'mark-generation-prompt.md');
const BRAND_DIR    = path.join(PROJECT_ROOT, 'design', 'brand');
const PRODUCT_OVERVIEW_FILE = path.join(PROJECT_ROOT, 'design', 'product-plan', 'product-overview.md');

// Brand tokens
const ROSE_900  = '#881337';
const STONE_50  = '#fafaf9';
const STONE_600 = '#57534e';

const PRODUCT_DESCRIPTION =
  'A 60-second visual quiz becomes a pack of six Pinterest-pinnable wedding artifacts. No subscription.';

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

// Shared mark inner content (occupies 60×56 starting at 0,0). Hosts
// (wordmark, OG, etc.) embed it inside their own transforms and backplates.
function markInnerSvg(opts = {}) {
  const indent = opts.indent || '    ';
  return [
    `${indent}<rect x="0"  y="0"  width="18" height="26" rx="2" fill="#e7e5e4"/>`,
    `${indent}<rect x="21" y="0"  width="18" height="26" rx="2" fill="#fecdd3"/>`,
    `${indent}<rect x="42" y="0"  width="18" height="26" rx="2" fill="#e7e5e4"/>`,
    `${indent}<rect x="0"  y="30" width="18" height="26" rx="2" fill="#fda4af"/>`,
    `${indent}<rect x="21" y="30" width="18" height="26" rx="2" fill="#${ROSE_900.slice(1)}"/>`,
    `${indent}<rect x="42" y="30" width="18" height="26" rx="2" fill="#e7e5e4"/>`,
  ].join('\n');
}

function fallbackWordmarkSvg() {
  // Unified: mark in 72×68 rounded backplate (6px padding around the 60×56
  // mark inner) + the Fraunces italic brand name. The padding math matters —
  // NOTE: the 320×96 canvas is tuned for a ~9-character brand name. Longer
  // names need a wider viewBox; the vision check below catches clipping.
  // the previous version had backplate width=68 with the mark extending to
  // x=74, so the mark visibly stuck out the right side. Vision check now
  // catches that class of bug; this math fixes the immediate instance.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 96" width="320" height="96">
  <rect x="0" y="14" width="72" height="68" rx="14" fill="${STONE_50}"/>
  <g transform="translate(6, 20)">
${markInnerSvg()}
  </g>
  <text x="84" y="64" text-anchor="start"
        font-family="Fraunces, Georgia, serif"
        font-style="italic" font-weight="600" font-size="44"
        fill="${ROSE_900}">${BRAND_NAME}</text>
</svg>
`;
}

// Read-or-fallback helper for brand assets.
async function resolveBrandSvg(filename, fallback) {
  try {
    const svg = await fs.readFile(path.join(BRAND_DIR, filename), 'utf-8');
    if (/^<svg[\s>]/m.test(svg)) {
      log(`  using design/brand/${filename} override`);
      return svg;
    }
  } catch (e) { if (e.code !== 'ENOENT') log(`  ${filename} override read errored: ${e.message}`); }
  return fallback();
}

async function svgWordmarkResolved() {
  return await resolveBrandSvg('logo.svg', fallbackWordmarkSvg);
}

// Mark generation strategy (in order):
//   1. design/brand/logo-mark.svg if present (project override — hand-crafted)
//   2. claude -p with mark-generation-prompt.md (LLM, palette + concept aware)
//   3. fallbackMarkSvg() — generic pack-grid template adapted to the palette
//
// Each strategy is tried in order; first to produce valid SVG wins.

function fallbackMarkSvg() {
  // Generic "pack-of-6" grid: 6 mini-cards in 3x2 layout, center-bottom
  // card in primary-900 to suggest "your chosen direction." Works as a
  // neutral default for any project — content products especially.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <rect width="96" height="96" rx="18" fill="${STONE_50}"/>
  <g transform="translate(18, 20)">
    <rect x="0"  y="0"  width="18" height="26" rx="2" fill="#e7e5e4"/>
    <rect x="21" y="0"  width="18" height="26" rx="2" fill="#fecdd3"/>
    <rect x="42" y="0"  width="18" height="26" rx="2" fill="#e7e5e4"/>
    <rect x="0"  y="30" width="18" height="26" rx="2" fill="#fda4af"/>
    <rect x="21" y="30" width="18" height="26" rx="2" fill="#${ROSE_900.slice(1)}"/>
    <rect x="42" y="30" width="18" height="26" rx="2" fill="#e7e5e4"/>
  </g>
</svg>
`;
}

async function readBrandOverride() {
  try {
    const svg = await fs.readFile(path.join(BRAND_DIR, 'logo-mark.svg'), 'utf-8');
    if (!/^<svg[\s>]/m.test(svg)) {
      log('  design/brand/logo-mark.svg present but does not start with <svg; ignoring');
      return null;
    }
    log('  using design/brand/logo-mark.svg override');
    return svg;
  } catch (e) {
    if (e.code !== 'ENOENT') log(`  brand override read errored: ${e.message}`);
    return null;
  }
}

async function generateMarkViaClaude() {
  // Best-effort. Returns null on any failure; caller falls back.
  let prompt;
  try {
    const template = await fs.readFile(PROMPT_FILE, 'utf-8');
    const tplBlock = template.match(/```prompt-template\s*\n([\s\S]*?)```/);
    if (!tplBlock) { log('  mark-generation-prompt.md missing ```prompt-template block; skipping LLM'); return null; }
    prompt = tplBlock[1];
  } catch {
    log('  mark-generation-prompt.md not found; skipping LLM generation');
    return null;
  }

  let overview = '';
  try { overview = (await fs.readFile(PRODUCT_OVERVIEW_FILE, 'utf-8')).slice(0, 2000); }
  catch { log('  product-overview.md not found; skipping LLM generation'); return null; }

  const productName = path.basename(PROJECT_ROOT);
  const palette = [STONE_50, '#e7e5e4', '#fecdd3', '#fda4af', ROSE_900, STONE_600, '#a7f3d0', '#047857'];

  prompt = prompt
    .replace('{{PRODUCT_NAME}}', productName)
    .replace('{{PRODUCT_OVERVIEW}}', overview)
    .replace('{{PRIMARY_FAMILY}}', 'rose')
    .replace('{{SECONDARY_FAMILY}}', 'emerald')
    .replace('{{NEUTRAL_FAMILY}}', 'stone')
    .replace('{{HEX_PALETTE_LIST}}', palette.map((h) => `- ${h}`).join('\n'));

  await fs.writeFile(path.join(STATE_SUB, 'claude-mark-prompt.txt'), prompt);

  log('  invoking claude -p for mark generation (best-effort)...');
  const r = spawnSync('claude',
    ['-p', prompt, '--model', 'opus', '--permission-mode', 'bypassPermissions'],
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) {
    log(`  claude -p exited ${r.status}; falling back`);
    return null;
  }
  const out = r.stdout || '';
  await fs.writeFile(path.join(STATE_SUB, 'claude-mark-response.txt'), out);
  const m = out.match(/<svg[\s\S]*?<\/svg>/);
  if (!m) { log('  claude response had no <svg>; falling back'); return null; }
  log('  using LLM-generated SVG mark');
  return m[0];
}

// Vision-check the rendered raster of an asset by invoking `claude -p` with
// the image path + per-asset criteria. Halts on FAIL — the whole point is
// to catch composition bugs without human babysitting.
//
// Disable by setting SKILL_SKIP_VISION_CHECK=1 (useful for offline / CI).
// Vision-check criteria. These describe the *design intent* — be specific
// about composition bugs, but don't be so strict that valid design choices
// trigger false positives. When iterating, prefer "X must be true" over
// "exactly N elements must be Y" phrasings.
const VISION_CRITERIA = {
  'logo-mark': [
    'All 6 mini-cards are fully contained inside the rounded backplate with visible padding on every side.',
    'A single dark-rose accent card is visible (it can be any one of the 6 positions). The other 5 cards may be a mix of neutral-stone tones and lighter rose tones — that gradient is intentional.',
    'No card touches the canvas edges or extends past the backplate.',
  ],
  'wordmark': [
    'The mark fits entirely inside its rounded backplate — no cards stick out left, right, top, or bottom.',
    `The "${BRAND_NAME}" text is fully visible: not clipped at the right edge of the canvas, not overlapping the mark.`,
    'The mark and the text appear vertically aligned (their centerlines roughly match).',
  ],
  'favicon': [
    'The 6 mini-cards are visible and the dark-rose accent card is identifiable.',
    'Composition is not visibly distorted or clipped.',
  ],
  'apple-touch-icon': [
    'All 6 mini-cards fit inside the rounded backplate.',
    'A single dark-rose accent card is visible. The other 5 may be neutral or lighter rose — that mix is intentional.',
    'No clipping at the canvas edges.',
  ],
  'og-image': [
    'The mark at the top is centered inside its backplate, no cards sticking out.',
    'All text strings (section marker, headline lines, supporting copy, wordmark) are fully visible — no clipping at left/right canvas edges, no overlapping text blocks.',
    `The bottom-row signature shows a small mark followed by the word "${BRAND_NAME}" — they should not overlap.`,
    'Overall composition feels balanced — content does not crowd one corner.',
  ],
};

async function visionCheck(imagePath, assetName) {
  if (process.env.SKILL_SKIP_VISION_CHECK === '1') {
    log(`  ${assetName}: vision check skipped (SKILL_SKIP_VISION_CHECK=1)`);
    return { ok: true, notes: 'skipped', skipped: true };
  }
  const criteria = VISION_CRITERIA[assetName] || ['Composition is correct and nothing is obviously broken.'];
  const prompt = `Use the Read tool to open the image at ${imagePath}. It is a rendered brand asset of type "${assetName}".

Evaluate it strictly against these criteria:
${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Be precise but practical. Minor sub-pixel imperfections are fine. Reject obvious composition bugs (text clipped, elements bleeding past containers, mark off-center, etc.).

Reply with a brief assessment, then on the LAST line of your reply output exactly one of:
VISION_PASS
VISION_FAIL: <one short sentence naming the most prominent issue>`;

  const r = spawnSync('claude',
    ['-p', prompt, '--model', 'opus', '--permission-mode', 'bypassPermissions'],
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });

  await fs.writeFile(
    path.join(STATE_SUB, `vision-check-${assetName}.log`),
    `--- prompt ---\n${prompt}\n\n--- exit ${r.status} ---\n--- stdout ---\n${r.stdout || ''}\n\n--- stderr ---\n${r.stderr || ''}\n`
  );

  // The vision gate is MANDATORY by default. We only get here if the user did
  // NOT set SKILL_SKIP_VISION_CHECK=1 (that's handled at the top of this
  // function). So a missing/failed claude is a hard FAIL — not a silent pass.
  // Otherwise a fresh/offline/unauthenticated machine could ship un-reviewed
  // assets while the receipt honestly claims the gate ran.
  if (r.error || r.status === null) {
    return { ok: false, notes: `claude CLI not runnable (${r.error?.code || 'no exit code'}) — vision gate is mandatory; set SKILL_SKIP_VISION_CHECK=1 to bypass` };
  }
  if (r.status !== 0) {
    return { ok: false, notes: `claude -p exited ${r.status} — vision gate is mandatory; set SKILL_SKIP_VISION_CHECK=1 to bypass` };
  }
  const out = r.stdout || '';
  const failMatch = out.match(/VISION_FAIL[:\s]+(.+)/i);
  if (failMatch) return { ok: false, notes: failMatch[1].trim() };
  if (/VISION_PASS\b/.test(out)) return { ok: true, notes: 'vision-pass' };
  return { ok: false, notes: 'response had no PASS/FAIL marker' };
}

async function resolveMarkSvg() {
  const override = await readBrandOverride();
  if (override) return { svg: override, source: 'project-override' };

  const llm = await generateMarkViaClaude();
  if (llm) return { svg: llm, source: 'llm-claude' };

  log('  using built-in fallback (generic pack-grid template)');
  return { svg: fallbackMarkSvg(), source: 'fallback-template' };
}

// Favicon: same pack-grid as logo-mark for brand unification, but no
// rounded-square backplate so the mark sits cleanly on dark browser tabs.
function fallbackFaviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <g transform="translate(18, 20)">
${markInnerSvg()}
  </g>
</svg>
`;
}

async function svgFaviconResolved() {
  return await resolveBrandSvg('favicon.svg', fallbackFaviconSvg);
}

// OG card: pack-grid mark in a soft backplate at top → DM Sans section
// marker → editorial two-clause Fraunces headline (upright + italic-rose
// per brand pattern) → supporting copy → bottom wordmark+mini-mark
// signature. Atmospheric rose/emerald glows in opposing corners.
function svgOgImage() {
  const innerForOg = markInnerSvg({ indent: '      ' });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <radialGradient id="roseGlow" cx="18%" cy="20%" r="55%">
      <stop offset="0%" stop-color="#fecdd3" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${STONE_50}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="emeraldGlow" cx="88%" cy="92%" r="45%">
      <stop offset="0%" stop-color="#a7f3d0" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${STONE_50}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="${STONE_50}"/>
  <rect width="1200" height="630" fill="url(#roseGlow)"/>
  <rect width="1200" height="630" fill="url(#emeraldGlow)"/>

  <!-- mark at top center in soft rounded backplate -->
  <g transform="translate(540, 78)">
    <rect width="120" height="120" rx="22" fill="${STONE_50}"/>
    <g transform="translate(22, 26) scale(1.31)">
${innerForOg}
    </g>
  </g>

  <g transform="translate(600, 252)">
    <line x1="-200" y1="0" x2="-90" y2="0" stroke="#d6d3d1" stroke-width="1"/>
    <text x="0" y="5" text-anchor="middle"
          font-family="DM Sans, system-ui, sans-serif"
          font-size="14" font-weight="500"
          letter-spacing="6"
          fill="${STONE_600}">A WEDDING AESTHETIC AI</text>
    <line x1="90" y1="0" x2="200" y2="0" stroke="#d6d3d1" stroke-width="1"/>
  </g>

  <text x="600" y="350" text-anchor="middle"
        font-family="Fraunces, Georgia, serif"
        font-weight="500" font-size="64"
        fill="#1c1917">Your wedding mood pack,</text>
  <text x="600" y="430" text-anchor="middle"
        font-family="Fraunces, Georgia, serif"
        font-style="italic" font-weight="500" font-size="64"
        fill="${ROSE_900}">in 60 seconds.</text>

  <text x="600" y="500" text-anchor="middle"
        font-family="DM Sans, system-ui, sans-serif"
        font-weight="400" font-size="24"
        fill="${STONE_600}">Six Pinterest-pinnable artifacts. One-time purchase.</text>

  <!-- bottom wordmark signature: mini mark + brand name -->
  <g transform="translate(530, 555)">
    <g transform="translate(0, 5) scale(0.55)">
${innerForOg}
    </g>
    <text x="48" y="32" text-anchor="start"
          font-family="Fraunces, Georgia, serif"
          font-style="italic" font-weight="600" font-size="28"
          fill="${ROSE_900}">${BRAND_NAME}</text>
  </g>
</svg>
`;
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || PROJECT_ROOT,
    stdio: opts.stdio || ['ignore', 'inherit', 'inherit'],
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
  return r;
}

async function ensureDeps() {
  const pkg = JSON.parse(await fs.readFile(PKG_JSON, 'utf-8'));
  const want = ['@resvg/resvg-js', 'png-to-ico'];
  const missing = want.filter((d) => !pkg.dependencies?.[d] && !pkg.devDependencies?.[d]);
  if (missing.length === 0) {
    log('  @resvg/resvg-js + png-to-ico already in deps');
    return;
  }
  run('npm', ['install', '--no-fund', '--no-audit', ...missing]);
}

// Each entry: name (used for cache filename) + Google Fonts CSS URL.
const FONT_DOWNLOADS = [
  { name: 'Fraunces-Italic', css: 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@1,9..144,600&display=swap' },
  { name: 'Fraunces-Roman',  css: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&display=swap' },
  { name: 'DMSans',          css: 'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap' },
];

async function downloadFonts() {
  await fs.mkdir(FONT_CACHE, { recursive: true });
  const results = [];
  for (const f of FONT_DOWNLOADS) {
    const ttfPath = path.join(FONT_CACHE, `${f.name}.ttf`);
    try { await fs.access(ttfPath); log(`  ${f.name}.ttf already cached`); results.push(ttfPath); continue; } catch {}
    try {
      const cssRes = await fetch(f.css, { headers: { 'User-Agent': 'Wget/1.21.3' } });
      if (!cssRes.ok) { log(`  ${f.name}: Google Fonts CSS HTTP ${cssRes.status}; skipping`); continue; }
      const css = await cssRes.text();
      const m = css.match(/src:\s*url\(([^)]+)\)\s*format\(['"]?(?:truetype|woff2?)['"]?\)/);
      if (!m) { log(`  ${f.name}: could not parse font URL; skipping`); continue; }
      const fontUrl = m[1].replace(/['"]/g, '');
      const ext = fontUrl.match(/\.(ttf|otf|woff2?)/)?.[1] || 'ttf';
      const destPath = path.join(FONT_CACHE, `${f.name}.${ext}`);
      const fontRes = await fetch(fontUrl);
      if (!fontRes.ok) { log(`  ${f.name}: font download HTTP ${fontRes.status}; skipping`); continue; }
      const buf = Buffer.from(await fontRes.arrayBuffer());
      await fs.writeFile(destPath, buf);
      log(`  downloaded ${f.name}.${ext} (${buf.length} bytes)`);
      results.push(destPath);
    } catch (e) {
      log(`  ${f.name}: download errored (${e.message.split('\n')[0]}); skipping`);
    }
  }
  return results;
}

async function renderPng(svgString, width, fontPaths) {
  const { Resvg } = await import('@resvg/resvg-js');
  const fontOpts = fontPaths.length > 0
    ? { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: 'Fraunces' }
    : { loadSystemFonts: true, defaultFontFamily: 'Georgia' };
  const resvg = new Resvg(svgString, { font: fontOpts, fitTo: { mode: 'width', value: width } });
  return resvg.render().asPng();
}

async function writeAssets(fontPaths) {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.mkdir(SVG_DUMP, { recursive: true });

  // SVG sources (each can be overridden via design/brand/<name>.svg)
  log('▶ Resolving brand SVG sources...');
  const wordmark = await svgWordmarkResolved();
  const markResolved = await resolveMarkSvg();
  const mark96 = markResolved.svg;
  const fav    = await svgFaviconResolved();
  const og     = svgOgImage();

  await fs.writeFile(path.join(PUBLIC_DIR, 'logo.svg'),       wordmark);
  await fs.writeFile(path.join(PUBLIC_DIR, 'logo-mark.svg'),  mark96);
  await fs.writeFile(path.join(PUBLIC_DIR, 'favicon.svg'),    fav);
  log('  wrote public/{logo,logo-mark,favicon}.svg');

  // Dump SVG sources for audit
  await fs.writeFile(path.join(SVG_DUMP, 'logo.svg'),      wordmark);
  await fs.writeFile(path.join(SVG_DUMP, 'logo-mark.svg'), mark96);
  await fs.writeFile(path.join(SVG_DUMP, 'favicon.svg'),   fav);
  await fs.writeFile(path.join(SVG_DUMP, 'og-image.svg'),  og);

  // PNG renders. Favicons render from the favicon.svg source (the pack-grid
  // mark without a backplate) so the
  // glyph stays legible at 16px; apple-touch + og use the richer sources.
  const png16  = await renderPng(fav,    16,  fontPaths);
  const png32  = await renderPng(fav,    32,  fontPaths);
  const png48  = await renderPng(fav,    48,  fontPaths);
  const png180 = await renderPng(mark96, 180, fontPaths);
  const png192 = await renderPng(mark96, 192, fontPaths);
  const png512 = await renderPng(mark96, 512, fontPaths);
  const pngOg  = await renderPng(og,    1200, fontPaths);

  // Capture the mark source for receipt visibility.
  globalThis.__markSource = markResolved.source;

  await fs.writeFile(path.join(PUBLIC_DIR, 'apple-touch-icon.png'), png180);
  await fs.writeFile(path.join(PUBLIC_DIR, 'logo192.png'),          png192);
  await fs.writeFile(path.join(PUBLIC_DIR, 'logo512.png'),          png512);
  await fs.writeFile(path.join(PUBLIC_DIR, 'og-image.png'),         pngOg);
  log(`  wrote public/apple-touch-icon.png (${png180.length}B), logo192.png (${png192.length}B), logo512.png (${png512.length}B), og-image.png (${pngOg.length}B)`);

  // Patch public/manifest.json — keep the PWA icons in sync with the brand
  // and set name + brand theme/background colors. The scaffold ships a
  // generic TanStack manifest; we own it now.
  await patchManifest();

  // Render the wordmark + standalone mark + favicon to PNG as well so we
  // can vision-check them (they're SVG in production, but vision review
  // needs rasters).
  const wordmarkPng = await renderPng(wordmark, 640, fontPaths);
  const markPng     = await renderPng(mark96, 384, fontPaths);
  const faviconPng  = await renderPng(fav, 96, fontPaths);
  await fs.writeFile(path.join(STATE_SUB, 'preview-wordmark.png'),       wordmarkPng);
  await fs.writeFile(path.join(STATE_SUB, 'preview-logo-mark.png'),      markPng);
  await fs.writeFile(path.join(STATE_SUB, 'preview-favicon.png'),        faviconPng);

  // Multi-res ICO
  const pngToIco = (await import('png-to-ico')).default;
  const icoBuf = await pngToIco([png16, png32, png48]);
  await fs.writeFile(path.join(PUBLIC_DIR, 'favicon.ico'), icoBuf);
  log(`  wrote public/favicon.ico (${icoBuf.length}B, multi-res 16+32+48)`);

  return {
    wordmark, mark96, fav, og,
    visionTargets: [
      { name: 'wordmark',         path: path.join(STATE_SUB, 'preview-wordmark.png') },
      { name: 'logo-mark',        path: path.join(STATE_SUB, 'preview-logo-mark.png') },
      { name: 'favicon',          path: path.join(STATE_SUB, 'preview-favicon.png') },
      { name: 'apple-touch-icon', path: path.join(PUBLIC_DIR, 'apple-touch-icon.png') },
      { name: 'og-image',         path: path.join(PUBLIC_DIR, 'og-image.png') },
    ],
  };
}

// Patch public/manifest.json: brand name (from CLAUDE.md / project dir),
// brand theme colors, and ensure the icon entries point at our generated
// assets. Idempotent — preserves any extra keys the scaffold set.
async function patchManifest() {
  const manifestPath = path.join(PUBLIC_DIR, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  } catch {
    manifest = {}; // create fresh if absent
  }
  const titled = BRAND_NAME;
  manifest.short_name = manifest.short_name && manifest.short_name !== 'TanStack App'
    ? manifest.short_name : titled;
  manifest.name = manifest.name && manifest.name !== 'Create TanStack App Sample'
    ? manifest.name : titled;
  manifest.icons = [
    { src: 'favicon.ico', sizes: '64x64 32x32 24x24 16x16', type: 'image/x-icon' },
    { src: 'logo192.png', type: 'image/png', sizes: '192x192' },
    { src: 'logo512.png', type: 'image/png', sizes: '512x512' },
  ];
  manifest.start_url = manifest.start_url || '.';
  manifest.display = manifest.display || 'standalone';
  manifest.theme_color = ROSE_900;   // brand primary
  manifest.background_color = STONE_50;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log(`  patched public/manifest.json (name="${manifest.name}", theme ${ROSE_900})`);
}

const NEW_ROOT_TSX = `import { HeadContent, Scripts, createRootRoute, useNavigate } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { AppShell } from '../components/shell'

import appCss from '../styles.css?url'

const DESCRIPTION = ${JSON.stringify(PRODUCT_DESCRIPTION)}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: ${JSON.stringify(BRAND_NAME)} },
      { name: 'description', content: DESCRIPTION },
      { property: 'og:title', content: ${JSON.stringify(BRAND_NAME)} },
      { property: 'og:description', content: DESCRIPTION },
      { property: 'og:image', content: '/og-image.png' },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'alternate icon', href: '/favicon.ico' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppShellWrapper>{children}</AppShellWrapper>
        <TanStackDevtools
          config={{ position: 'bottom-right' }}
          plugins={[
            { name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}

function AppShellWrapper({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  return (
    <AppShell
      user={null}
      navigationItems={[]}
      onNavigate={(href) => navigate({ to: href as never })}
      onSignIn={() => navigate({ to: '/login' as never })}
      onLogout={() => { /* wired in skill 15 (ralph-build) when auth lands */ }}
    >
      {children}
    </AppShell>
  )
}
`;

async function patchRootTsx() {
  const before = await fs.readFile(ROOT_TSX, 'utf-8');
  await fs.writeFile(path.join(STATE_SUB, '__root.tsx.before.txt'), before);
  await fs.writeFile(ROOT_TSX, NEW_ROOT_TSX);
  log('  rewrote src/routes/__root.tsx (added icon links + OG meta)');
}

async function main() {
  loadEnv();
  await fs.mkdir(STATE_SUB, { recursive: true });

  const prior = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', '03-shell.json'), 'utf-8')
  );
  if (prior.status !== 'ok') die('03-shell not ok; halting.');

  log('▶ Installing @resvg/resvg-js + png-to-ico...');
  await ensureDeps();

  log('▶ Ensuring Fraunces (italic + roman) and DM Sans TTFs cached...');
  const fontPaths = await downloadFonts();

  log('▶ Generating SVG sources + rendering rasters...');
  const writeResult = await writeAssets(fontPaths);

  log('▶ Vision-checking rendered assets via claude -p...');
  const visionResults = {};
  for (const target of writeResult.visionTargets) {
    log(`  ${target.name}: checking ${target.path}...`);
    const result = await visionCheck(target.path, target.name);
    visionResults[target.name] = result;
    if (!result.ok) {
      // Persist results so far before halting so the user has the audit trail.
      await fs.writeFile(
        path.join(STATE_SUB, 'vision-results.json'),
        JSON.stringify(visionResults, null, 2) + '\n'
      );
      die(
        `Vision check FAILED for ${target.name}: ${result.notes}\n` +
        `  Inspect ${target.path}, fix the source SVG (likely under design/brand/), and re-run.\n` +
        `  Full prompt + response: ${path.join(STATE_SUB, `vision-check-${target.name}.log`)}\n` +
        `  To skip vision checks temporarily: SKILL_SKIP_VISION_CHECK=1 node .skills/04-logo/setup.mjs`
      );
    }
    log(`    ✓ ${result.notes}`);
  }
  await fs.writeFile(
    path.join(STATE_SUB, 'vision-results.json'),
    JSON.stringify(visionResults, null, 2) + '\n'
  );

  log('▶ Patching src/routes/__root.tsx with icon links + OG meta...');
  await patchRootTsx();

  // Derive SVG dims from the file's own width/height (or viewBox) rather than
  // hardcoding — hardcoded dims drifted out of sync with the actual assets
  // across design revisions. PNG/ICO dims are known from how we render them.
  async function svgDims(file) {
    const svg = await fs.readFile(path.join(PUBLIC_DIR, file), 'utf-8');
    const wh = svg.match(/width="(\d+)"\s+height="(\d+)"/);
    if (wh) return `${wh[1]}×${wh[2]}`;
    const vb = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
    if (vb) return `${vb[1]}×${vb[2]}`;
    return 'unknown';
  }
  const sizeOf = async (file) => (await fs.stat(path.join(PUBLIC_DIR, file))).size;

  const summary = {
    publicAssets: {
      'logo.svg':             { size: await sizeOf('logo.svg'),             dims: await svgDims('logo.svg') },
      'logo-mark.svg':        { size: await sizeOf('logo-mark.svg'),        dims: await svgDims('logo-mark.svg') },
      'favicon.svg':          { size: await sizeOf('favicon.svg'),          dims: await svgDims('favicon.svg') },
      'favicon.ico':          { size: await sizeOf('favicon.ico'),          dims: '16+32+48 multi-res' },
      'apple-touch-icon.png': { size: await sizeOf('apple-touch-icon.png'), dims: '180×180' },
      'logo192.png':          { size: await sizeOf('logo192.png'),          dims: '192×192 (PWA)' },
      'logo512.png':          { size: await sizeOf('logo512.png'),          dims: '512×512 (PWA)' },
      'og-image.png':         { size: await sizeOf('og-image.png'),         dims: '1200×630' },
    },
    manifestPatched: true,
    fonts: fontPaths.length > 0 ? { paths: fontPaths, status: 'downloaded' } : { status: 'fallback-to-system-serif' },
    markSource: globalThis.__markSource || 'unknown',
    rootTsxRewritten: ROOT_TSX,
    description: PRODUCT_DESCRIPTION,
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(STATE_SUB, 'patch-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await fs.writeFile(
    path.join(STATE_SUB, 'fonts-source.json'),
    JSON.stringify({
      sources: FONT_DOWNLOADS.map((f) => ({ name: f.name, googleFontsCss: f.css })),
      cachedAt: fontPaths,
      fallback: fontPaths.length === 0 ? 'system serif' : null,
    }, null, 2) + '\n'
  );

  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
