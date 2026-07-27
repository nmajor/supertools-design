---
name: 02-design-tokens
description: Wire the project design tokens (palette from the Design OS export + typography + CSS custom properties) into the scaffold's Tailwind 4 setup.
---

# 02 — Design tokens

Wire the design system from `design/product-plan/design-system/` into the
scaffold's `src/styles.css`. Tailwind 4 is config-via-CSS, so this is a
single-file edit: swap the scaffold's Google Fonts `@import` and `@theme`
block for the project's, then append the portable `:root` tokens from
`tokens.css`.

The `rose` / `emerald` / `stone` palette is stock Tailwind — no palette
extension required.

## Inputs

- `.supertools-state/01-project-init.json` (status: ok)
- `design/product-plan/design-system/fonts.md`
- `design/product-plan/design-system/tokens.css`

## What setup.mjs does to `src/styles.css`

1. Replaces the scaffold's `@import url("https://fonts.googleapis.com/...")`
   line with the project's full URL (Fraunces full `opsz` + italic + weights
   400/500/600/700, DM Sans, IBM Plex Mono).
2. Replaces the scaffold's `@theme { ... }` block so Tailwind 4's
   typography utilities map to the project fonts:
   ```css
   @theme {
     --font-sans:  "DM Sans", ui-sans-serif, system-ui, sans-serif;
     --font-serif: "Fraunces", Georgia, serif;
     --font-mono:  "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
   }
   ```
3. Appends the contents of `design-system/tokens.css` at the bottom of
   `src/styles.css` inside `BEGIN`/`END` markers so non-Tailwind consumers
   (inline styles, sample components) can read `--color-primary-*`,
   `--font-heading`, etc. The markers make re-runs idempotent.

The scaffold's `lagoon`/`sea`/`island-shell` demo CSS is **left in place**
— it's still referenced by the scaffold's Header/Footer/ThemeToggle. Skill
`03-shell` removes those components and the supporting CSS together.

## Steps

1. Run setup:
   ```sh
   node .skills/02-design-tokens/setup.mjs
   ```
2. Run verifier:
   ```sh
   node .skills/02-design-tokens/verify.mjs
   ```
3. Stage candidate at `.supertools-state/02-design-tokens.candidate.json`.
4. Council review per `.skills/_shared/council.md`. On `COUNCIL_APPROVED`,
   rename candidate → `.supertools-state/02-design-tokens.json`.

## Output

- `src/styles.css` patched (Google Fonts URL, `@theme` typography, appended
  `:root` token block).
- `.supertools-state/02-design-tokens.json` — receipt.
- Raw artifacts under `.supertools-state/02-design-tokens/`:
  - `styles.css.before.txt` — verbatim pre-patch snapshot
  - `patch-summary.json` — what setup wrote
  - `verify-output.log`

## Idempotency

Re-runnable. setup.mjs uses begin/end markers around the appended tokens
block and a regex match for the @import + @theme replacements, so running
the skill twice produces the same file.

## Common failure modes

| Symptom | Fix |
|---|---|
| `npm run build` fails after patch | Likely a malformed `@theme` block. Restore from `styles.css.before.txt` and re-run. |
| Browser still shows Manrope instead of DM Sans | Hard-refresh; Tailwind 4 caches utility CSS aggressively in dev. |
| Verifier complains tokens.css markers missing on second run | The `BEGIN`/`END` comment lines were edited by hand — remove them and re-run setup. |
