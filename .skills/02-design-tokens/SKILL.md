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

**Every value comes from the export.** This skill embeds no font, no colour,
and no palette of its own — if `design/product-plan/design-system/` does not
say it, it is not written. It is also the only skill that owns typography;
`03-shell` re-reads what this one wrote rather than declaring its own.

## Inputs

- `.supertools-state/01-project-init.json` (status: ok)
- `design/product-plan/design-system/tokens.css` — the palette and the
  `--font-heading` / `--font-body` / `--font-mono` stacks
- `design/product-plan/design-system/fonts.md` — the Google Fonts sheet, and
  a role table used as a fallback if `tokens.css` declares no `--font-*`
- optional `design/product-plan/design-system/fonts.json` — `{ "url": … }` to
  override the webfont sheet

## What setup.mjs does to `src/styles.css`

1. Replaces the scaffold's `@import url("https://fonts.googleapis.com/...")`
   line with the sheet the export declares. If the export declares no
   webfonts, the scaffold's `@import` is **removed** — shipping another
   project's fonts is worse than shipping none.
2. Replaces the scaffold's `@theme { ... }` block so Tailwind 4's typography
   utilities map to the export's font roles:

   | Tailwind utility | `@theme` property | Bound to |
   |---|---|---|
   | `font-sans` | `--font-sans` | the **body** face |
   | `font-serif` | `--font-serif` | the **heading/display** face, whether or not it is a serif — `font-serif` is the utility this pipeline's page templates use for headings, so the binding is by role |
   | `font-mono` | `--font-mono` | the **mono** face |

   A role the export does not define is omitted, leaving Tailwind's own
   default rather than another project's brand.
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
   The verifier asserts **consistency with this project's own export**, not
   any named font or colour: every custom property `tokens.css` declares must
   appear in `src/styles.css` with the same value, the `@theme` map must match
   the export's font roles, and the webfont `@import` must be the export's
   sheet (or absent, if the export declares none).
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
| Browser still shows the scaffold's font | Hard-refresh; Tailwind 4 caches utility CSS aggressively in dev. |
| Verifier complains tokens.css markers missing on second run | The `BEGIN`/`END` comment lines were edited by hand — remove them and re-run setup. |
| `No font stacks found in the Design OS export` | `tokens.css` declares no `--font-heading`/`--font-body`/`--font-mono` and `fonts.md` has no role table. Re-run Design OS's `/design-tokens`. |
| Verifier: `tokens match the Design OS export — differing: …` | `src/styles.css` was hand-edited after setup, or the export changed. Re-run setup; it rewrites the marked block. |
