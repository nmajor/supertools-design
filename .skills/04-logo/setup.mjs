#!/usr/bin/env node
// 04-logo setup.
// Generate the brand SVG wordmark + favicon set; patch __root.tsx head.
//
// EVERY brand value here comes from the project: colours and type from the
// Design OS export (design/product-plan/design-system/), name/domain/tagline
// from .supertools-state/project.json. Nothing in this file names a colour,
// a typeface, or a product. An earlier version hardcoded the reference
// implementation's rose/stone palette, Fraunces, and its wedding tagline, so
// every project shipped that brand's assets under its own name.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';
import {
  requireExport, palette, parseTokens, fontFamilies, primaryFamilyName,
  perFamilyFontUrls, paletteFamilyNames, productDescription, EXPORT_DIR,
} from '../_shared/design-os.mjs';

const PROJECT    = readProject();
const BRAND_NAME = PROJECT.brandName;
const DOMAIN     = PROJECT.domain || null;

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

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

// ── Brand values, resolved from the Design OS export ────────────────────────
// Resolved once at module load so every asset draws from the same source.
// `primary` is required (00-prereqs gates on it). Where a role the export does
// not define is genuinely needed to draw anything at all, the substitute is a
// PLAIN NEUTRAL (white / near-black), never another project's brand colour.
const TOKENS   = parseTokens();
const P        = palette(TOKENS);
const FAMILIES = fontFamilies(TOKENS);

const BRAND = {
  primary:   P.primary,
  secondary: P.secondary || P.primary,
  neutral:   P.neutral   || '#52525b',
  surface:   P.surface   || '#ffffff',
  ink:       P.ink       || '#18181b',
  headingFont: FAMILIES.heading || FAMILIES.body || 'system-ui, sans-serif',
  bodyFont:    FAMILIES.body    || FAMILIES.heading || 'system-ui, sans-serif',
};

// XML-escape any project string before it goes into an SVG.
function xml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// A font-family attribute value: SVG wants an unquoted, comma-separated list.
function svgFontFamily(stack) {
  return xml(String(stack).replace(/['"]/g, ''));
}

// Shared mark inner content (occupies 60×60 starting at 0,0). Hosts (wordmark,
// OG card, favicon) embed it inside their own transforms and backplates.
//
// The shape is deliberately GENERIC: two offset rounded squares reading as
// "layers". It is a neutral placeholder that claims nothing about the product,
// and it is only ever used when the project supplies no design/brand/*.svg and
// the LLM path produces nothing. Say so in the receipt (markSource) rather
// than letting it pass as a designed mark.
function markInnerSvg(opts = {}) {
  const indent = opts.indent || '    ';
  return [
    `${indent}<rect x="2"  y="2"  width="34" height="34" rx="8" fill="${BRAND.primary}"/>`,
    `${indent}<rect x="24" y="24" width="34" height="34" rx="8" fill="${BRAND.secondary}" fill-opacity="0.85"/>`,
  ].join('\n');
}

// The wordmark canvas has to fit the brand name — a fixed 320×96 canvas
// clipped anything longer than ~9 characters. Estimate the advance width of
// the name at the chosen size and size the viewBox to it.
const WORDMARK_FONT_SIZE = 44;
function wordmarkWidth() {
  const textWidth = Math.ceil(BRAND_NAME.length * WORDMARK_FONT_SIZE * 0.58);
  return Math.max(320, 88 + textWidth + 24);
}

function fallbackWordmarkSvg() {
  // Mark in a 72×72 rounded backplate (6px padding around the 60×60 mark
  // inner) + the brand name in the export's heading face and primary colour.
  const w = wordmarkWidth();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 96" width="${w}" height="96">
  <rect x="0" y="12" width="72" height="72" rx="14" fill="${BRAND.surface}"/>
  <g transform="translate(6, 18)">
${markInnerSvg()}
  </g>
  <text x="88" y="63" text-anchor="start"
        font-family="${svgFontFamily(BRAND.headingFont)}"
        font-weight="600" font-size="${WORDMARK_FONT_SIZE}"
        fill="${BRAND.primary}">${xml(BRAND_NAME)}</text>
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
//   3. fallbackMarkSvg() — the neutral placeholder below
//
// Each strategy is tried in order; first to produce valid SVG wins.

function fallbackMarkSvg() {
  // Deliberately generic placeholder, not a designed mark: two offset rounded
  // squares in the project's own primary/secondary. It says nothing about the
  // product because this skill knows nothing about the product's imagery — a
  // shape that DID mean something would mean the previous project's thing.
  // The receipt records markSource: "fallback-template" so this is never
  // mistaken for a considered design.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <rect width="96" height="96" rx="18" fill="${BRAND.surface}"/>
  <g transform="translate(18, 18)">
${markInnerSvg()}
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

  // Palette family NAMES come from the export's tailwind-colors.md when it
  // records them ("indigo" / "cyan" / "zinc"); otherwise the model is given
  // the hexes alone rather than a colour word from somewhere else.
  const familyNames = paletteFamilyNames();
  // Every colour the design system declares, deduped, so the model cannot
  // invent one that clashes with the rest of the brand.
  const hexes = [...new Set(
    [...TOKENS.values()].filter((v) => /^#[0-9a-f]{3,8}$/i.test(v.trim())).map((v) => v.trim())
  )];

  prompt = prompt
    .replace('{{PRODUCT_NAME}}', BRAND_NAME)
    .replace('{{PRODUCT_OVERVIEW}}', overview)
    .replace('{{PRIMARY_FAMILY}}', familyNames.primary || BRAND.primary)
    .replace('{{SECONDARY_FAMILY}}', familyNames.secondary || BRAND.secondary)
    .replace('{{NEUTRAL_FAMILY}}', familyNames.neutral || BRAND.neutral)
    .replace('{{HEX_PALETTE_LIST}}', hexes.map((h) => `- ${h}`).join('\n'));

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
//
// The criteria describe COMPOSITION ONLY — containment, clipping, overlap,
// alignment. They deliberately do not describe any particular mark, because
// the mark may come from a project override or an LLM and this skill has no
// idea what it depicts. Criteria that named specific shapes and colours ("a
// dark-rose accent card", "6 mini-cards") were meaningless for every project
// but the one they were written for, and would fail a perfectly good mark.
const VISION_CRITERIA = {
  'logo-mark': [
    'Every element of the mark is fully contained inside the rounded backplate, with visible padding on all four sides.',
    'Nothing is clipped by the canvas edge and nothing extends past the backplate.',
    'The composition reads as a deliberate mark, not as elements scattered or stacked by accident.',
  ],
  'wordmark': [
    // Brand-neutral: check for composition BUGS, not for a particular
    // composition. This used to read "the mark fits entirely inside its
    // rounded backplate", which presupposed the fallback design's backplate —
    // so a project whose brand deliberately uses a bare glyph was told its
    // "plate layer dropped out". Whether a mark sits on a plate is the
    // project's call (authoring-checklist rule 23); whether something bleeds
    // out of a container it DOES have is a real defect.
    'If the mark sits on a backplate or inside any container, it fits entirely within it — nothing bleeds out left, right, top, or bottom. A mark with no container is a legitimate design choice, not a failure.',
    `The text "${BRAND_NAME}" is fully visible: not clipped at the right edge of the canvas, and not overlapping the mark.`,
    'The mark and the text appear vertically aligned (their centerlines roughly match).',
  ],
  'favicon': [
    'The mark is legible at this small size — the shapes are distinguishable, not a smudge.',
    'Composition is not visibly distorted or clipped.',
  ],
  'apple-touch-icon': [
    'The whole mark fits inside the rounded backplate with padding on all sides.',
    'No clipping at the canvas edges.',
  ],
  'og-image': [
    'The mark at the top is centered inside its backplate and nothing sticks out of it.',
    'Every text string is fully visible — no clipping at the left or right canvas edge, and no two text blocks overlapping each other.',
    `The product name "${BRAND_NAME}" is readable and is the most prominent text on the card.`,
    'Overall composition feels balanced — content does not crowd one corner, and there is no large empty band.',
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

// Favicon: same mark as logo-mark for brand unification, but no rounded-square
// backplate so it sits cleanly on light and dark browser tabs alike.
function fallbackFaviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <g transform="translate(18, 18)">
${markInnerSvg()}
  </g>
</svg>
`;
}

async function svgFaviconResolved() {
  return await resolveBrandSvg('favicon.svg', fallbackFaviconSvg);
}

// Greedy word wrap for SVG <text> — SVG has no text flow, so lines must be
// laid out here. `perLine` is a character budget, calibrated from the font
// size against the canvas width by the caller.
function wrapText(text, perLine, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > perLine && line) { lines.push(line); line = w; }
    else line = next;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  // If the copy did not fit, end the last line with an ellipsis rather than
  // silently dropping the rest.
  const used = lines.join(' ').split(/\s+/).length;
  if (used < words.length && lines.length) lines[lines.length - 1] += '…';
  return lines;
}

// OG card: the mark in a soft backplate at the top, the product name in the
// export's heading face, the product's own one-line description beneath it,
// and the domain as a sign-off. Every string is the project's: name and domain
// from project.json, description from project.json `context` or the export's
// product-overview.md. Atmospheric glows use the project's primary/secondary.
function svgOgImage(description) {
  const innerForOg = markInnerSvg({ indent: '      ' });
  const descLines = description ? wrapText(description, 62, 3) : [];
  const descSvg = descLines.map((line, i) => `
  <text x="600" y="${430 + i * 40}" text-anchor="middle"
        font-family="${svgFontFamily(BRAND.bodyFont)}"
        font-weight="400" font-size="26"
        fill="${BRAND.neutral}">${xml(line)}</text>`).join('');
  const domainSvg = DOMAIN ? `
  <text x="600" y="572" text-anchor="middle"
        font-family="${svgFontFamily(BRAND.bodyFont)}"
        font-weight="500" font-size="22" letter-spacing="2"
        fill="${BRAND.neutral}">${xml(DOMAIN)}</text>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <radialGradient id="primaryGlow" cx="18%" cy="20%" r="55%">
      <stop offset="0%" stop-color="${BRAND.primary}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${BRAND.surface}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="secondaryGlow" cx="88%" cy="92%" r="45%">
      <stop offset="0%" stop-color="${BRAND.secondary}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${BRAND.surface}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="${BRAND.surface}"/>
  <rect width="1200" height="630" fill="url(#primaryGlow)"/>
  <rect width="1200" height="630" fill="url(#secondaryGlow)"/>

  <!-- mark at top center in a soft rounded backplate -->
  <g transform="translate(540, 88)">
    <rect width="120" height="120" rx="22" fill="${BRAND.surface}"/>
    <g transform="translate(12, 12) scale(1.6)">
${innerForOg}
    </g>
  </g>

  <text x="600" y="330" text-anchor="middle"
        font-family="${svgFontFamily(BRAND.headingFont)}"
        font-weight="600" font-size="72"
        fill="${BRAND.primary}">${xml(BRAND_NAME)}</text>
${descSvg}${domainSvg}
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

// The fonts to fetch are the ones THIS project's design system declares, with
// each family's own axis spec preserved from the export's combined Google
// Fonts URL. (Cache filenames are slugified from the family name.)
const FONT_DOWNLOADS = perFamilyFontUrls().map((f) => ({
  name: f.name.replace(/[^A-Za-z0-9]+/g, ''),
  family: f.name,
  css: f.css,
}));

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
  // The default family is the project's heading face — resvg falls back to it
  // for any glyph the SVG's font-family chain does not resolve.
  const headingName = primaryFamilyName(BRAND.headingFont);
  const fontOpts = fontPaths.length > 0
    ? { fontFiles: fontPaths, loadSystemFonts: false, defaultFontFamily: headingName }
    : { loadSystemFonts: true, defaultFontFamily: headingName };
  const resvg = new Resvg(svgString, { font: fontOpts, fitTo: { mode: 'width', value: width } });
  return resvg.render().asPng();
}

async function writeAssets(fontPaths, description) {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.mkdir(SVG_DUMP, { recursive: true });

  // SVG sources (each can be overridden via design/brand/<name>.svg)
  log('▶ Resolving brand SVG sources...');
  const wordmark = await svgWordmarkResolved();
  const markResolved = await resolveMarkSvg();
  const mark96 = markResolved.svg;
  const fav    = await svgFaviconResolved();
  const og     = svgOgImage(description);

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
  manifest.theme_color = BRAND.primary;
  manifest.background_color = BRAND.surface;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log(`  patched public/manifest.json (name="${manifest.name}", theme ${BRAND.primary})`);
}

// The description is the project's own words (project.json `context`, else the
// Design OS product-overview summary). When the project has said nothing about
// itself, the description meta tags are OMITTED rather than filled with copy
// this skill made up.
const NEW_ROOT_TSX = (PRODUCT_DESCRIPTION) => `import { HeadContent, Scripts, createRootRoute, useNavigate } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { AppShell } from '../components/shell'

import appCss from '../styles.css?url'
${PRODUCT_DESCRIPTION ? `
const DESCRIPTION = ${JSON.stringify(PRODUCT_DESCRIPTION)}
` : ''}
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: ${JSON.stringify(BRAND_NAME)} },${PRODUCT_DESCRIPTION ? `
      { name: 'description', content: DESCRIPTION },` : ''}
      { property: 'og:title', content: ${JSON.stringify(BRAND_NAME)} },${PRODUCT_DESCRIPTION ? `
      { property: 'og:description', content: DESCRIPTION },` : ''}
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

// Insert ONLY the meta/link entries this skill owns, leaving the rest of
// __root.tsx alone.
//
// This used to write NEW_ROOT_TSX over the whole file. That template carries
// its own AppShellWrapper with hardcoded `user={null} navigationItems={[]}
// onNavigate={...}` props — the shell the skill was written against — so it
// silently reverted 03-shell's prop-aware wrapper and broke `tsc` with TS2322
// and TS7006. A skill that says it "added icon links + OG meta" must not
// rewrite an unrelated component while it is in there.
function upsertEntries(block, entries, matchKey) {
  // block: the raw text between [ and ] of a meta:/links: array.
  let out = block.replace(/\s*$/, '');
  let added = 0;
  for (const { match, text } of entries) {
    if (match.test(out)) continue;
    const indent = (out.match(/\n(\s+)\S/) || [null, '      '])[1];
    if (out.trim() && !/,\s*$/.test(out)) out += ',';
    out += `\n${indent}${text},`;
    added++;
  }
  return { text: out + '\n    ', added };
}

function spliceArray(src, key, entries) {
  // Find `key: [` inside the head() object and return [start,end) of its body.
  const keyIdx = src.indexOf(`${key}: [`);
  if (keyIdx < 0) return { src, added: 0 };
  const open = src.indexOf('[', keyIdx);
  let i = open + 1, depth = 1, inStr = null;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    i++;
  }
  if (depth !== 0) return { src, added: 0 };
  const close = i - 1;
  const body = src.slice(open + 1, close);
  const { text, added } = upsertEntries(body, entries);
  return { src: src.slice(0, open + 1) + text + src.slice(close), added };
}

async function patchRootTsx(description) {
  const before = await fs.readFile(ROOT_TSX, 'utf-8');
  await fs.writeFile(path.join(STATE_SUB, '__root.tsx.before.txt'), before);

  const metaEntries = [
    { match: /property:\s*'og:title'/,        text: `{ property: 'og:title', content: ${JSON.stringify(BRAND_NAME)} }` },
    { match: /property:\s*'og:image'[^:]/,     text: "{ property: 'og:image', content: '/og-image.png' }" },
    { match: /property:\s*'og:image:width'/,   text: "{ property: 'og:image:width', content: '1200' }" },
    { match: /property:\s*'og:image:height'/,  text: "{ property: 'og:image:height', content: '630' }" },
    { match: /property:\s*'og:type'/,          text: "{ property: 'og:type', content: 'website' }" },
    { match: /name:\s*'twitter:card'/,         text: "{ name: 'twitter:card', content: 'summary_large_image' }" },
  ];
  // Only claim a description when the project actually supplied one.
  if (description) {
    metaEntries.unshift(
      { match: /name:\s*'description'/,        text: `{ name: 'description', content: ${JSON.stringify(description)} }` },
      { match: /property:\s*'og:description'/, text: `{ property: 'og:description', content: ${JSON.stringify(description)} }` },
    );
  }
  const linkEntries = [
    { match: /rel:\s*'icon'/,             text: "{ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }" },
    { match: /rel:\s*'alternate icon'/,   text: "{ rel: 'alternate icon', href: '/favicon.ico' }" },
    { match: /rel:\s*'apple-touch-icon'/, text: "{ rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }" },
  ];

  let next = before;
  const m = spliceArray(next, 'meta', metaEntries); next = m.src;
  const l = spliceArray(next, 'links', linkEntries); next = l.src;

  if (m.added === 0 && l.added === 0) {
    log('  src/routes/__root.tsx already carries the icon links + OG meta');
    return;
  }
  // Guard: only the head arrays may have changed. If anything else moved, the
  // splice went wrong — halt with the original intact.
  const stripHead = (t) => t.replace(/head:\s*\(\)\s*=>\s*\(\{[\s\S]*?\}\),/, 'HEAD');
  if (stripHead(before) !== stripHead(next)) {
    die('The __root.tsx splice changed something outside head(); refusing to write. ' +
        'Original preserved at ' + path.join(STATE_SUB, '__root.tsx.before.txt'));
  }
  await fs.writeFile(ROOT_TSX, next);
  log(`  patched src/routes/__root.tsx (+${m.added} meta, +${l.added} link entries; the rest untouched)`);
}

async function main() {
  loadEnv();
  await fs.mkdir(STATE_SUB, { recursive: true });

  const prior = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', '03-shell.json'), 'utf-8')
  );
  if (prior.status !== 'ok') die('03-shell not ok; halting.');

  try { requireExport(); } catch (e) { die(e.message); }
  if (!BRAND.primary) {
    die(`No primary colour in the Design OS export (${EXPORT_DIR}/design-system/tokens.css).\n` +
        `  Expected --color-primary or --color-primary-<n>. Re-run Design OS's /design-tokens step.`);
  }

  // The one-line description used for the OG card and the meta description.
  // project.json `context` (written by 00-prereqs from the export) wins;
  // otherwise the export's product-overview summary. Never a stock sentence —
  // if the project has said nothing about itself, the card carries the name
  // and domain alone.
  const { text: description, source: descriptionSource } = productDescription(PROJECT);
  log(`▶ Brand: ${BRAND_NAME} · primary ${BRAND.primary} · heading ${primaryFamilyName(BRAND.headingFont)}`);
  log(`▶ Description from ${descriptionSource}`);

  log('▶ Installing @resvg/resvg-js + png-to-ico...');
  await ensureDeps();

  log(`▶ Ensuring TTFs cached for ${FONT_DOWNLOADS.map((f) => f.family).join(', ') || '(no webfonts declared)'}...`);
  const fontPaths = await downloadFonts();

  log('▶ Generating SVG sources + rendering rasters...');
  const writeResult = await writeAssets(fontPaths, description);

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
  await patchRootTsx(description);

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
    fonts: fontPaths.length > 0
      ? { families: FONT_DOWNLOADS.map((f) => f.family), paths: fontPaths, status: 'downloaded' }
      : { families: FONT_DOWNLOADS.map((f) => f.family), status: 'fallback-to-system-fonts' },
    markSource: globalThis.__markSource || 'unknown',
    rootTsxRewritten: ROOT_TSX,
    // Where each brand value came from — no constant in this skill.
    brand: {
      name: BRAND_NAME,
      domain: DOMAIN,
      primary: BRAND.primary,
      secondary: BRAND.secondary,
      surface: BRAND.surface,
      headingFont: BRAND.headingFont,
      bodyFont: BRAND.bodyFont,
      source: `${EXPORT_DIR}/design-system + .supertools-state/project.json`,
    },
    description,
    descriptionSource,
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
