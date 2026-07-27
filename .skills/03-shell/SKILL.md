---
name: 03-shell
description: Replace the scaffold's demo Header/Footer/ThemeToggle with the shell components the Design OS export ships; wire onNavigate to TanStack Router; clean up the scaffold's demo CSS.
---

# 03 — Shell

Drop the application shell from `design/product-plan/shell/` into the
scaffold. After this skill the home page renders the real wordmark and the
brand chrome that every section sits inside.

**Which components exist is the export's call.** The file list is read from
`design/product-plan/shell/components/` rather than fixed here — one project's
shell has a `Footer`, another's does not, and a third adds a command bar.
`AppShell.tsx` and `index.ts` are the only required members.

**Typography belongs to skill 02.** This skill rewrites `src/styles.css`, so
it has to carry the font `@import` and `@theme` block across — it reads them
out of the file 02 wrote instead of declaring its own copy.

## Inputs

- `.supertools-state/02-design-tokens.json` (status: ok)
- `design/product-plan/shell/components/*.{tsx,ts}` — must include
  `AppShell.tsx` and `index.ts`
- `src/styles.css` as skill 02 left it (the `@theme` block and the
  `BEGIN`/`END` token markers)

## What setup.mjs does

1. **Installs `@radix-ui/react-dropdown-menu`** (used by `UserMenu`).
2. **Copies every component the export ships** from
   `design/product-plan/shell/components/` to `src/components/shell/`.
   Verbatim — these are framework-agnostic, props-based.
3. **Deletes scaffold demos**: `src/components/{Header, Footer, ThemeToggle}.tsx`.
4. **Rewrites `src/routes/__root.tsx`** to wrap `{children}` with `<AppShell>`,
   via a small `AppShellWrapper` that consumes TanStack Router's `useNavigate`
   for the `onNavigate` / `onSignIn` callbacks. `user={null}` for now — auth
   wires into skill 15 (ralph-build). `<title>` set to the brand name from `project.json`.
5. **Rewrites `src/styles.css`** to a clean minimum: skill 02's webfont
   `@import` and `@theme` typography map carried across verbatim,
   `@import "tailwindcss"`, `@plugin "@tailwindcss/typography"`, a tiny
   box-sizing/body reset, and skill 02's `:root` token block (extracted via
   its BEGIN/END markers). The lagoon/sea/island-shell demo CSS the scaffold
   shipped is dropped. Halts if the `@theme` block is missing rather than
   substituting a default.

## Steps

1. ```sh
   node .skills/03-shell/setup.mjs
   ```
2. ```sh
   node .skills/03-shell/verify.mjs
   ```
3. Stage candidate at `.supertools-state/03-shell.candidate.json`.
4. Council review per `.skills/_shared/council.md`. On `COUNCIL_APPROVED`,
   rename candidate → `.supertools-state/03-shell.json`.

## Verifier checks

- Every shell component the export ships exists at `src/components/shell/`.
- Three scaffold demo files gone.
- `@radix-ui/react-dropdown-menu` in `dependencies`.
- `__root.tsx` imports `AppShell` and uses `useNavigate`.
- `src/styles.css` has no lagoon/sea/island-shell selectors; still carries
  every custom property the export's `tokens.css` declares, and still has an
  `@theme` block.
- `npm run build` green, `npx tsc --noEmit` green.
- `vite dev` GET `/` returns 2xx and the HTML contains the brand name from
  `project.json`.

## Output

- `src/components/shell/` (one file per component in the export).
- `src/routes/__root.tsx` rewritten.
- `src/styles.css` rewritten clean.
- `package.json` adds `@radix-ui/react-dropdown-menu`.
- `.supertools-state/03-shell.json` receipt.
- Raw artifacts under `.supertools-state/03-shell/`:
  - `__root.tsx.before.txt`, `styles.css.before.txt` — pre-patch snapshots
  - `patch-summary.json`, `verify-output.log`

## Idempotency

Re-runnable. setup.mjs overwrites the shell component files (canonical source
is `design/product-plan/shell/`), checks the dep list before npm-installing,
and the styles.css rewrite produces the same output each run.

## Common failure modes

| Symptom | Fix |
|---|---|
| TS error on `navigate({ to: href })` — typed routes won't accept untyped strings | The template uses `href as never` to defeat strict literal typing. If your TS strict settings still complain, change to `href as unknown as never`. |
| `useNavigate` throws "no router context" | Wrapper is rendered above the router. It must live inside `<body>` after `Scripts` registers — check ordering in `__root.tsx`. |
| Wordmark click reloads instead of SPA navigating | `onNavigate` isn't being passed through. Confirm the chain `AppShellWrapper → AppShell → MainNav → wordmark <a>` in the components. |
