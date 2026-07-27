---
name: 04-logo
description: Generate the brand SVG wordmark + favicon set (favicon.svg, favicon.ico, apple-touch-icon, og-image) from brand tokens; patch __root.tsx head with icon links + OG meta. Deterministic, no external image-gen API.
---

# 04 — Logo

Generate the brand asset set entirely from brand tokens
(Fraunces italic + rose + stone). All raster files are derived from SVG
via `@resvg/resvg-js` — no external image-gen API.

For raster fidelity, the setup script downloads **three font files** from
Google Fonts (best-effort, cached at `.supertools-state/_cache/fonts/`):
Fraunces-Italic, Fraunces-Roman, and DM Sans. All three are registered with
resvg so the OG card can use the editorial two-clause headline pattern
(Fraunces upright + Fraunces italic-rose) plus DM Sans for the mono-cap
section marker and supporting copy. If any download fails the rasters fall
back to system serif. The SVG sources always carry full `font-family`
fallback chains so browsers render correctly regardless.

## Inputs

- `.supertools-state/03-shell.json` (status: ok)

## Outputs (under `public/`)

Dimensions below describe the current (unified pack-grid) design. The setup
summary derives SVG dims from each file's own attributes rather than
hardcoding, so the receipt always reflects what actually shipped.

| File | Size | Purpose |
|---|---|---|
| `logo.svg` | 320×96 | Full lockup — pack-grid mark in a rounded backplate + the brand name in Fraunces italic rose-900 |
| `logo-mark.svg` | 96×96 | Standalone brand mark (pack-grid) — resolved from project override → LLM-generated → built-in fallback (see "How the mark is chosen" below) |
| `favicon.svg` | 96×96 | The pack-grid mark without a backplate, so it sits cleanly on light + dark tabs |
| `favicon.ico` | 16+32+48 multi-res | Browser tab icon (legacy fallback) — rendered from `favicon.svg` |
| `apple-touch-icon.png` | 180×180 | iOS home-screen icon — rendered from the `logo-mark.svg` source |
| `logo192.png` | 192×192 | PWA icon — rendered from `logo-mark.svg`; referenced by `manifest.json` |
| `logo512.png` | 512×512 | PWA icon — rendered from `logo-mark.svg`; referenced by `manifest.json` |
| `og-image.png` | 1200×630 | OpenGraph card — pack-grid mark at top, editorial two-clause headline ("Your wedding mood pack, in 60 seconds."), section marker, supporting copy, and a mini-mark + wordmark sign-off |

Plus `public/manifest.json` is patched: PWA icon entries point at the
generated `logo192.png` / `logo512.png`, the generic scaffold name is
replaced with the project name, and `theme_color` / `background_color` are
set to the brand rose / stone.

## Vision check (every raster, every run)

Setup vision-checks each rendered raster (`wordmark`, `logo-mark`, `favicon`,
`apple-touch-icon`, `og-image`) by invoking `claude -p` with the image path
and a per-asset criteria list (text not clipped, mark contained in
backplate, accent visible, no overlapping elements, etc.). The skill
**halts** on `VISION_FAIL` with the AI's one-sentence reason and the
absolute paths to the offending image + full prompt/response log.

This is non-optional by default — the whole point is to catch composition
bugs (text overflow, mark sticking out of its container, misaligned
elements) before assets ship, without human babysitting.

To bypass for offline runs or CI:
```sh
SKILL_SKIP_VISION_CHECK=1 node .skills/04-logo/setup.mjs
```

All vision-check prompts + responses are saved under
`.supertools-state/04-logo/vision-check-<asset>.log` for audit.

## How the mark is chosen

For `logo-mark.svg` (the 96×96 brand mark that also feeds the apple-touch-icon
render), setup.mjs tries three sources in order. First valid result wins.

1. **Project override**: `design/brand/logo-mark.svg` if present. Hand-crafted
   wins; the skill never overwrites a project's own mark.
2. **LLM-generated**: `claude -p` is invoked with the templated prompt at
   `.skills/04-logo/mark-generation-prompt.md`, substituting the project's
   product overview, brand palette, and key hex colors. The prompt constrains
   the LLM to basic shapes only (rect/circle/ellipse/line/path), no
   letterforms, ≤4 colors from the palette, and enumerates anti-clichés
   (single-letter-in-rounded-square, generic 4-petal, smiley/face, etc.).
3. **Fallback template**: a generic pack-of-6 grid in stone + rose tones —
   neutral default that suggests "a curated set" without claiming product
   specifics.

In the reference implementation, `design/brand/logo-mark.svg` is committed (hand-crafted
pack-grid), so paths 2 and 3 don't fire on this project. For a fresh project
without that file, path 2 takes over. If `claude -p` isn't authenticated or
returns no `<svg>` block, path 3 ships.

Both the LLM prompt and the LLM response are saved under
`.supertools-state/04-logo/` (`claude-mark-prompt.txt`,
`claude-mark-response.txt`) when the LLM path is taken, for audit + tuning.

## What setup.mjs does

1. **Install deps**: `@resvg/resvg-js` (SVG → PNG renderer) + `png-to-ico`
   (multi-res ICO assembler). Both are pure JS with prebuilt native binaries.
2. **Download three TTF files** from Google Fonts (`User-Agent: Wget/...`
   to force TTF instead of WOFF2): `Fraunces-Italic`, `Fraunces-Roman`,
   `DMSans`. Cached at `.supertools-state/_cache/fonts/`. Re-runs skip
   downloads that are already cached.
3. **Write SVG sources**: `logo.svg`, `logo-mark.svg` (resolved per the
   strategy above), `favicon.svg`, and one internal `og-image.svg`
   template — all use brand tokens (rose `#881337`, stone `#fafaf9`).
4. **Render PNGs** via resvg-js: 16/32/48 (for ICO), 180 (apple-touch),
   192 + 512 (PWA, from the mark), 1200×630 (OG). Fraunces TTF is registered
   with resvg if available; otherwise it falls back to system serif.
5. **Assemble `favicon.ico`** from the 16/32/48 PNGs via png-to-ico.
   **Patch `public/manifest.json`** — PWA icon entries, project name, and
   brand theme/background colors.
6. **Rewrite `src/routes/__root.tsx`**: add icon `<link>` entries
   (`rel="icon"`, `rel="alternate icon"`, `rel="apple-touch-icon"`) and OG
   `<meta>` entries (`og:title`, `og:description`, `og:image`,
   `twitter:card`). The description string is the `PRODUCT_DESCRIPTION`
   constant in `setup.mjs` (sourced from the product spec; edit it there if
   the positioning copy changes).

## Steps

1. ```sh
   node .skills/04-logo/setup.mjs
   ```
2. ```sh
   node .skills/04-logo/verify.mjs
   ```
3. Stage candidate at `.supertools-state/04-logo.candidate.json`.
4. Council review per `.skills/_shared/council.md`. On `COUNCIL_APPROVED`,
   rename candidate → `.supertools-state/04-logo.json`.

## Verifier checks

- All six asset files exist under `public/` with non-trivial sizes.
- `favicon.ico` is a real ICO (header `00 00 01 00`).
- `apple-touch-icon.png` and `og-image.png` are valid PNGs (header
  `89 50 4E 47`).
- `__root.tsx` has the new `<link rel="icon">`, `<link rel="alternate icon">`,
  `<link rel="apple-touch-icon">`, and `<meta property="og:image">` entries.
- `npm run build` + `npx tsc --noEmit` green.
- `vite dev` GET `/favicon.svg`, `/favicon.ico`, `/apple-touch-icon.png`,
  `/og-image.png` all return 2xx.

## Output

- 6 brand asset files under `public/`.
- `src/routes/__root.tsx` rewritten with icon + OG head entries.
- `package.json` adds `@resvg/resvg-js` + `png-to-ico`.
- `.supertools-state/04-logo.json` receipt.
- Raw artifacts under `.supertools-state/04-logo/`:
  - `__root.tsx.before.txt`
  - `svg-sources/` — verbatim SVG sources for audit
  - `fraunces-font-source.json` — URL + cached TTF path
  - `patch-summary.json`, `verify-output.log`

## Idempotency

Re-runnable. SVG sources are templates; PNG rendering is deterministic
given the same TTF + SVG; `__root.tsx` is fully rewritten each run; ICO is
re-assembled from fresh PNGs.

## Common failure modes

| Symptom | Fix |
|---|---|
| `Cannot find module '@resvg/resvg-js-linux-x64-gnu'` | Native binary mismatch. Try `npm rebuild @resvg/resvg-js` or check `process.arch`. |
| Any font download HTTP 4xx | Google Fonts changed its CSS endpoint. Setup falls back to system serif for affected text automatically; raster styling drifts. |
| og-image.png text overflow | Increase `viewBox` width in the OG template, or shorten the description string. |
