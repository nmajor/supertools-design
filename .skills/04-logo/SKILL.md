---
name: 04-logo
description: Generate the brand SVG wordmark + favicon set (favicon.svg, favicon.ico, apple-touch-icon, og-image) from brand tokens; patch __root.tsx head with icon links + OG meta. Deterministic, no external image-gen API.
---

# 04 — Logo

Generate the brand asset set entirely from **this project's own** brand
values. All raster files are derived from SVG via `@resvg/resvg-js` — no
external image-gen API.

Nothing in this skill names a colour, a typeface, or a product:

| Value | Read from |
|---|---|
| primary / secondary / neutral / surface colours | `design/product-plan/design-system/tokens.css` |
| heading + body font stacks | `tokens.css` `--font-*`, else the `fonts.md` role table |
| which webfonts to fetch | the Google Fonts sheet in `design-system/fonts.md` |
| palette family names for the LLM prompt | `design-system/tailwind-colors.md` |
| brand name, domain | `.supertools-state/project.json` |
| the one-line description on the OG card and in `<meta>` | `project.json` `context`, else the export's `product-overview.md` summary |

If the project has said nothing about itself, the OG card carries the name and
domain alone and the description meta tags are omitted — this skill does not
write marketing copy on a project's behalf.

For raster fidelity the setup script downloads a TTF per declared font family
from Google Fonts (best-effort, cached at `.supertools-state/_cache/fonts/`)
and registers them with resvg. If a download fails the rasters fall back to
system fonts. The SVG sources always carry full `font-family` fallback chains
so browsers render correctly regardless.

## Inputs

- `.supertools-state/03-shell.json` (status: ok)
- `design/product-plan/design-system/{tokens.css, fonts.md, tailwind-colors.md}`
- `.supertools-state/project.json` (`brandName`, `domain`, `context`)

## Outputs (under `public/`)

Dimensions below describe the current (unified pack-grid) design. The setup
summary derives SVG dims from each file's own attributes rather than
hardcoding, so the receipt always reflects what actually shipped.

| File | Size | Purpose |
|---|---|---|
| `logo.svg` | *width* × 96 | Full lockup — mark in a rounded backplate + the brand name in the export's heading face and primary colour. **The width is computed from the brand name's length**; a fixed canvas clipped anything longer than about nine characters |
| `logo-mark.svg` | 96×96 | Standalone brand mark — resolved from project override → LLM-generated → neutral placeholder (see "How the mark is chosen" below) |
| `favicon.svg` | 96×96 | The mark without a backplate, so it sits cleanly on light + dark tabs |
| `favicon.ico` | 16+32+48 multi-res | Browser tab icon (legacy fallback) — rendered from `favicon.svg` |
| `apple-touch-icon.png` | 180×180 | iOS home-screen icon — rendered from the `logo-mark.svg` source |
| `logo192.png` | 192×192 | PWA icon — rendered from `logo-mark.svg`; referenced by `manifest.json` |
| `logo512.png` | 512×512 | PWA icon — rendered from `logo-mark.svg`; referenced by `manifest.json` |
| `og-image.png` | 1200×630 | OpenGraph card — mark at top, the product name in the heading face, the project's own one-line description beneath it, and the domain as a sign-off. Primary/secondary glows in opposing corners |

Plus `public/manifest.json` is patched: PWA icon entries point at the
generated `logo192.png` / `logo512.png`, the generic scaffold name is
replaced with the brand name, and `theme_color` / `background_color` are set
to the export's primary and surface colours.

## Vision check (every raster, every run)

Setup vision-checks each rendered raster (`wordmark`, `logo-mark`, `favicon`,
`apple-touch-icon`, `og-image`) by invoking `claude -p` with the image path
and a per-asset criteria list. The skill **halts** on `VISION_FAIL` with the
AI's one-sentence reason and the absolute paths to the offending image + full
prompt/response log.

The criteria describe **composition only** — containment, clipping, overlap,
alignment, legibility. They deliberately say nothing about what the mark
depicts or which colours appear in it: the mark may come from a project
override or an LLM, and criteria naming particular shapes and colours would
reject any mark but the one they were written for.

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
3. **Neutral placeholder**: two offset rounded squares in the project's own
   primary and secondary colours. It is **not a designed mark** — it claims
   nothing about the product, because this skill knows nothing about the
   product's imagery, and a shape that *did* mean something would mean some
   other project's thing. The receipt records `markSource:
   "fallback-template"` so it is never mistaken for considered work.

If a project commits `design/brand/logo-mark.svg`, paths 2 and 3 never fire.
Otherwise path 2 takes over; if `claude -p` isn't authenticated or returns no
`<svg>` block, path 3 ships.

Both the LLM prompt and the LLM response are saved under
`.supertools-state/04-logo/` (`claude-mark-prompt.txt`,
`claude-mark-response.txt`) when the LLM path is taken, for audit + tuning.

## What setup.mjs does

1. **Install deps**: `@resvg/resvg-js` (SVG → PNG renderer) + `png-to-ico`
   (multi-res ICO assembler). Both are pure JS with prebuilt native binaries.
2. **Download one TTF per declared font family** from Google Fonts
   (`User-Agent: Wget/...` to force TTF instead of WOFF2), taking the family
   list and each family's axis spec from the export's Google Fonts sheet.
   Cached at `.supertools-state/_cache/fonts/`. Re-runs skip downloads that
   are already cached.
3. **Write SVG sources**: `logo.svg`, `logo-mark.svg` (resolved per the
   strategy above), `favicon.svg`, and one internal `og-image.svg`
   template — all drawn with the export's own colours and font stacks.
4. **Render PNGs** via resvg-js: 16/32/48 (for ICO), 180 (apple-touch),
   192 + 512 (PWA, from the mark), 1200×630 (OG). The downloaded TTFs are
   registered with resvg, with the heading family as resvg's default;
   otherwise it falls back to system fonts.
5. **Assemble `favicon.ico`** from the 16/32/48 PNGs via png-to-ico.
   **Patch `public/manifest.json`** — PWA icon entries, project name, and
   brand theme/background colors.
6. **Rewrite `src/routes/__root.tsx`**: add icon `<link>` entries
   (`rel="icon"`, `rel="alternate icon"`, `rel="apple-touch-icon"`) and OG
   `<meta>` entries (`og:title`, `og:image`, `twitter:card`, and
   `description` / `og:description` when the project has a description).
   The description comes from `project.json` `context`, else the export's
   `product-overview.md` summary — change it there, not in `setup.mjs`.

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
  - `fonts-source.json` — per-family Google Fonts URL + cached TTF paths
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
