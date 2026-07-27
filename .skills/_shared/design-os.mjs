// Canonical accessor for the Design OS export.
//
// THE STARTING ASSUMPTION: every project that runs this pipeline has already
// completed Design OS and run its `/export-product` step, so
// `design/product-plan/` exists and is the source of truth for the brand.
// No skill may embed a palette, a font family, or a tagline of its own — if a
// value describes *this project's brand*, it is read from here.
//
// Design OS owns the shape of that directory (see its `export-product`
// command). The parts this pipeline consumes:
//
//   design/product-plan/
//   ├── product-overview.md            product name + summary prose
//   ├── design-system/
//   │   ├── tokens.css                 :root custom properties (the palette)
//   │   ├── fonts.md                   Google Fonts <link> + font roles
//   │   └── tailwind-colors.md         which stock Tailwind palettes were used
//   └── shell/components/*.tsx         AppShell + nav components
//
// Everything here degrades honestly: a parser that cannot find a value returns
// null and the caller decides whether that is fatal. Nothing invents a brand.

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './env.mjs';

export const EXPORT_DIR      = path.join(PROJECT_ROOT, 'design', 'product-plan');
export const DESIGN_SYSTEM_DIR = path.join(EXPORT_DIR, 'design-system');
export const SHELL_DIR       = path.join(EXPORT_DIR, 'shell', 'components');
export const TOKENS_CSS      = path.join(DESIGN_SYSTEM_DIR, 'tokens.css');
export const FONTS_MD        = path.join(DESIGN_SYSTEM_DIR, 'fonts.md');
export const FONTS_JSON      = path.join(DESIGN_SYSTEM_DIR, 'fonts.json');
export const TAILWIND_COLORS_MD = path.join(DESIGN_SYSTEM_DIR, 'tailwind-colors.md');
export const PRODUCT_OVERVIEW_MD = path.join(EXPORT_DIR, 'product-overview.md');

// The completeness contract. These are the files the pipeline actually reads;
// a "complete" export is one that lets 02/03/04 run without guessing.
export const REQUIRED_EXPORT_FILES = [
  'product-overview.md',
  'design-system/tokens.css',
  'design-system/fonts.md',
  'shell/components/AppShell.tsx',
];

const HELP =
  'Run Design OS to completion and finish with its `/export-product` step so\n' +
  '  design/product-plan/ exists. supertools-design starts from that export —\n' +
  '  it has no brand of its own to fall back on.';

/**
 * @returns {{ok: boolean, present: string[], missing: string[], exportDir: string}}
 */
export function checkExport() {
  const present = [];
  const missing = [];
  for (const rel of REQUIRED_EXPORT_FILES) {
    (fs.existsSync(path.join(EXPORT_DIR, rel)) ? present : missing).push(rel);
  }
  return { ok: missing.length === 0, present, missing, exportDir: EXPORT_DIR };
}

/** Throw a directive error unless the export is complete. */
export function requireExport() {
  const r = checkExport();
  if (!r.ok) {
    throw new Error(
      `Design OS export incomplete at ${EXPORT_DIR}\n` +
      `  missing: ${r.missing.join(', ')}\n  ${HELP}`
    );
  }
  return r;
}

/**
 * The shell component files this project's export actually contains.
 *
 * Design OS emits whatever the `/design-shell` step produced — the reference
 * implementation had a Footer, this one does not, and another might add a
 * CommandBar. Copying a fixed five-file list is how a skill ends up demanding
 * another project's components, so the list is read from disk.
 *
 * `AppShell.tsx` and `index.ts` are the contract: the shell entry point and
 * its barrel. Everything else alongside them comes along.
 *
 * @returns {string[]} filenames, `AppShell.tsx` first, then sorted
 */
export function shellComponentFiles() {
  let entries;
  try {
    entries = fs.readdirSync(SHELL_DIR, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    throw new Error(`Design OS shell components not found at ${SHELL_DIR}\n  ${HELP}`);
  }
  const files = entries
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name))
    .map((d) => d.name)
    .sort();
  for (const required of ['AppShell.tsx', 'index.ts']) {
    if (!files.includes(required)) {
      throw new Error(
        `${SHELL_DIR} has no ${required} — the export's shell is incomplete.\n` +
        `  Re-run Design OS's /design-shell step, then /export-product.`
      );
    }
  }
  return ['AppShell.tsx', ...files.filter((f) => f !== 'AppShell.tsx')];
}

function readMaybe(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function readTokensCss() { return readMaybe(TOKENS_CSS); }
export function readFontsMd()   { return readMaybe(FONTS_MD); }
export function readProductOverview() { return readMaybe(PRODUCT_OVERVIEW_MD); }

/**
 * Every custom property declared anywhere in the export's tokens.css, in
 * declaration order. Later declarations win (dark-mode blocks re-declare the
 * same names), so `parseTokens` keeps the FIRST value — the light-mode/base
 * one — which is what a light-first scaffold should use.
 *
 * @param {string} [css] defaults to the export's tokens.css
 * @returns {Map<string, string>} e.g. "--color-primary" → "#4f46e5"
 */
export function parseTokens(css = readTokensCss()) {
  const map = new Map();
  if (!css) return map;
  // Strip comments so a commented-out declaration never registers as real.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)) {
    const name = m[1].trim();
    if (!map.has(name)) map.set(name, m[2].trim());
  }
  return map;
}

/** First token whose name matches one of `names`, else null. */
function pick(tokens, names) {
  for (const n of names) if (tokens.has(n)) return tokens.get(n);
  return null;
}

/** First token whose name matches `re`, else null. */
function pickBy(tokens, re) {
  for (const [k, v] of tokens) if (re.test(k)) return v;
  return null;
}

/**
 * The brand colours, resolved from the export's tokens.css.
 *
 * Design OS projects name their tokens differently (`--color-primary` vs
 * `--color-primary-600` vs `--color-primary-900`), so each role tries the
 * unsuffixed name first, then any numbered variant. Every field may be null;
 * callers must not substitute a colour of their own without saying so.
 *
 * @returns {{primary: string|null, secondary: string|null, neutral: string|null,
 *            surface: string|null, surfaceAlt: string|null, ink: string|null}}
 */
export function palette(tokens = parseTokens()) {
  return {
    primary:    pick(tokens, ['--color-primary']) || pickBy(tokens, /^--color-primary-\d+$/),
    secondary:  pick(tokens, ['--color-secondary', '--color-accent']) || pickBy(tokens, /^--color-(secondary|accent)-\d+$/),
    neutral:    pick(tokens, ['--color-neutral', '--color-muted']) || pickBy(tokens, /^--color-neutral-\d+$/),
    surface:    pick(tokens, ['--surface-card', '--color-surface', '--surface-page', '--color-background']),
    surfaceAlt: pick(tokens, ['--surface-page', '--surface-card', '--color-background']),
    ink:        pick(tokens, ['--color-ink', '--color-text', '--color-foreground']) || pickBy(tokens, /^--color-neutral-9\d\d$/),
  };
}

/**
 * The three font stacks, resolved from tokens.css `--font-*` first (the
 * canonical record) and from the fonts.md role table as a fallback.
 *
 * @returns {{heading: string|null, body: string|null, mono: string|null, source: string}}
 */
export function fontFamilies(tokens = parseTokens()) {
  const heading = pick(tokens, ['--font-heading', '--font-display', '--font-serif']);
  const body    = pick(tokens, ['--font-body', '--font-sans']);
  const mono    = pick(tokens, ['--font-mono']);
  if (heading || body || mono) {
    return { heading, body, mono, source: 'design-system/tokens.css' };
  }

  // Fallback: the "Font usage" table in fonts.md — | Role | Font | ... |
  const md = readFontsMd();
  if (!md) return { heading: null, body: null, mono: null, source: 'none' };
  const byRole = {};
  for (const m of md.matchAll(/^\|\s*\*{0,2}(Headings?|Body|Mono)\*{0,2}\s*\|\s*([^|]+?)\s*\|/gim)) {
    byRole[m[1].toLowerCase()] = m[2].trim();
  }
  const quote = (f, fallbackStack) => (f ? `'${f}', ${fallbackStack}` : null);
  return {
    heading: quote(byRole.heading || byRole.headings, 'system-ui, sans-serif'),
    body:    quote(byRole.body, 'system-ui, sans-serif'),
    mono:    quote(byRole.mono, 'ui-monospace, monospace'),
    source:  'design-system/fonts.md (role table)',
  };
}

/** Strip quotes/fallbacks off a font stack: `'Space Grotesk', system-ui` → `Space Grotesk`. */
export function primaryFamilyName(stack) {
  if (!stack) return null;
  const first = String(stack).split(',')[0].trim();
  return first.replace(/^["']|["']$/g, '') || null;
}

/**
 * The Google Fonts stylesheet URL for this project.
 *
 * Resolution order:
 *   1. design-system/fonts.json `{ "url": ... }` — explicit per-project override.
 *   2. The `<link href="https://fonts.googleapis.com/...">` or `@import url(...)`
 *      in design-system/fonts.md, which is what Design OS emits.
 *   3. null — the design system uses no webfonts. Callers must then ship NO
 *      font @import rather than substituting one.
 *
 * @returns {{url: string|null, source: string}}
 */
export function googleFontsUrl() {
  const overrideRaw = readMaybe(FONTS_JSON);
  if (overrideRaw) {
    try {
      const j = JSON.parse(overrideRaw);
      if (j.url) return { url: j.url, source: 'design-system/fonts.json' };
    } catch { /* malformed override falls through to fonts.md */ }
  }
  const md = readFontsMd();
  if (md) {
    const m = md.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"'\s)>]+/);
    if (m) return { url: m[0].replace(/&amp;/g, '&'), source: 'design-system/fonts.md' };
  }
  return { url: null, source: 'none (design system declares no webfonts)' };
}

/** The `family=` names in a Google Fonts css2 URL: ["Space Grotesk", "Inter"]. */
export function familiesInUrl(url) {
  if (!url) return [];
  return [...new Set(
    [...url.matchAll(/family=([^:&]+)/g)]
      .map((m) => decodeURIComponent(m[1]).replace(/\+/g, ' '))
  )];
}

/**
 * Per-family Google Fonts css2 URLs, preserving each family's axis spec from
 * the export's combined URL. Used where fonts must be fetched one at a time
 * (e.g. downloading TTFs for server-side SVG rasterization).
 *
 * @returns {{name: string, css: string}[]}
 */
export function perFamilyFontUrls(url = googleFontsUrl().url) {
  if (!url) return [];
  const specs = [...url.matchAll(/family=([^&]+)/g)].map((m) => m[1]);
  return specs.map((spec) => {
    const name = decodeURIComponent(spec.split(':')[0]).replace(/\+/g, ' ');
    return { name, css: `https://fonts.googleapis.com/css2?family=${spec}&display=swap` };
  });
}

/**
 * The stock Tailwind palette NAMES the design system chose, from the
 * tailwind-colors.md role table (| **Primary** | `indigo` | ... |). These are
 * words a human/LLM can reason about ("indigo"), unlike raw hexes.
 *
 * @returns {{primary: string|null, secondary: string|null, neutral: string|null}}
 */
export function paletteFamilyNames() {
  const md = readMaybe(TAILWIND_COLORS_MD);
  const out = { primary: null, secondary: null, neutral: null };
  if (!md) return out;
  for (const m of md.matchAll(/^\|\s*\*{0,2}(Primary|Secondary|Neutral)\*{0,2}\s*\|\s*`?([a-z-]+)`?\s*\|/gim)) {
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/**
 * Product name + one-paragraph summary from product-overview.md.
 * `name` comes from the H1 ("# Acme — Product Overview" → "Acme").
 *
 * @returns {{name: string|null, summary: string|null}}
 */
export function productOverview() {
  const md = readProductOverview();
  if (!md) return { name: null, summary: null };

  let name = null;
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1) name = h1[1].replace(/\s*[—–-]\s*Product Overview\s*$/i, '').trim() || null;

  let summary = null;
  const sum = md.match(/^##\s+Summary\s*\n+([\s\S]*?)(?=\n#{2,}\s|\n\*\*|\n---)/m);
  if (sum) {
    // First paragraph only, unwrapped to a single line.
    summary = sum[1].trim().split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ').trim() || null;
  }
  return { name, summary };
}

/**
 * A one-line description suitable for a `<meta name="description">` / OG card.
 * `project.json.context` wins (the founder wrote it deliberately); otherwise
 * the export's summary, trimmed at a sentence boundary. Never invented.
 *
 * @param {{context?: string}} [project]
 * @param {number} [maxLen]
 * @returns {{text: string|null, source: string}}
 */
export function productDescription(project = {}, maxLen = 200) {
  const candidates = [
    [project.context, '.supertools-state/project.json (context)'],
    [productOverview().summary, 'design/product-plan/product-overview.md (summary)'],
  ];
  for (const [raw, source] of candidates) {
    if (!raw) continue;
    const flat = String(raw).replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    if (flat.length <= maxLen) return { text: flat, source };
    // Trim to the last sentence end that fits; fall back to a word boundary.
    const head = flat.slice(0, maxLen);
    const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
    const cut = lastStop > maxLen * 0.5 ? head.slice(0, lastStop + 1) : head.slice(0, head.lastIndexOf(' ')) + '…';
    return { text: cut.trim(), source };
  }
  return { text: null, source: 'none' };
}
