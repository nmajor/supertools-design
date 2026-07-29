---
name: 03-shell
description: Install the shell components the Design OS export ships, plus the design kit they import; wire the export's own callbacks to TanStack Router; retire scaffold demo chrome that nothing still references; reduce src/styles.css to a clean minimum.
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
- `design/product-plan/design-system/kit/*.{ts,tsx}` — optional; copied when
  present, because the shell components import it
- `src/styles.css` as skill 02 left it (the `@theme` block and the
  `BEGIN`/`END` token markers)

## What setup.mjs does

1. **Copies the export's design kit** from `design-system/kit/` to `src/kit/`,
   when the export ships one. The shell components import it from *outside*
   `shell/components/`, so copying only the components leaves those imports
   dangling and the project does not typecheck.
2. **Copies every component the export ships** to `src/components/shell/`,
   rewriting `../../design-system/kit/*` imports to the `@/kit/*` alias the
   scaffold's `tsconfig.json` already maps to `./src/*`. Throws if any
   `design-system/kit` reference survives the rewrite.
3. **Installs whatever the copied files import.** The package list is derived
   from the files, not held here — an earlier version installed one hardcoded
   Radix package, and any export importing anything else failed to build.
   Already-satisfied imports are reported and skipped.
4. **Retires scaffold demo chrome, but only when nothing references it.**
   `SCAFFOLD_DEMOS` names candidates; each is deleted only if no file in the
   project references it. References are found by parsing every source file
   with TypeScript and **resolving** each specifier against the real path on
   disk — including `tsconfig` path aliases such as `@/components/Footer`,
   which a relative-only check treated as invisible and would have deleted
   underneath. A referenced candidate is kept and its referrers logged.
5. **Rewrites `src/routes/__root.tsx`** to wrap `{children}` in `<AppShell>`.
   The wrapper passes **only callbacks the export's own `AppShellProps`
   declares** — `onNavigate`/`onSignIn`/`onNavigateStage`/`onSelectShort` are
   wired to TanStack Router, and known open/logout callbacks get stubs. Data
   props are deliberately left unset: there is no app yet, and inventing values
   would be this skill holding a design opinion. `useNavigate` is imported only
   if something needs it. `<title>` is the brand from `project.json`, emitted
   via `JSON.stringify` so a name containing a quote cannot break the file.
6. **Rewrites `src/styles.css`** to a clean minimum: every `@import`/`@plugin`
   directive already in the file carried across in order, skill 02's `@theme`
   block, and skill 02's token block (via its BEGIN/END markers). The
   scaffold's demo CSS is dropped. Halts if the `@theme` block is missing
   rather than substituting a default. **No reset is emitted** — the previous
   box-sizing/body/font-smoothing reset was a design opinion and is gone.

   `@import`/`@plugin` directives AND skill 02's `@theme` block are extracted
   with **postcss**, not by hand. Three scanner generations each failed
   differently — a plain `[^;]+;` cut the webfont sheet at the first semicolon
   inside its own quoted URL; a quote-aware version mishandled escaped quotes
   and comments containing semicolons; a full hand-rolled scanner activated
   `@import` text inside a block comment and truncated block-form `@plugin`.
   The `@theme` regex had the same class of bug: it truncated at a `}` inside
   a declaration value such as `--font-test: "a}b";`. postcss is already
   present (Tailwind depends on it); if it cannot be loaded the skill HALTS
   rather than degrading to a regex.

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
- Each scaffold demo candidate is **either** gone **or** still referenced by
  something, with the referrers named. Asserting unconditional removal was
  wrong — the scaffold's marketing layout imports `Footer`, and deleting it
  broke the build. The invariant is a consistent project, not an absent file.
- `__root.tsx` imports `AppShell` and uses `useNavigate`.
- `src/styles.css` has no scaffold demo selectors; still carries every custom
  property the export's `tokens.css` declares, and still has an `@theme` block.
- `npm run build` green, `npx tsc --noEmit` green.
- `vite dev` GET `/` returns 2xx and the **rendered `<body>`** contains the
  brand from `project.json`. Body, not the whole document: `__root.tsx` puts
  the brand in `<title>`, so searching the full HTML passed whether or not the
  shell rendered at all.

- **Every external package the copied files import is declared** in
  `package.json`. This replaced a hard requirement for one named Radix
  package, which was wrong twice over: setup installs what the export imports,
  so a project importing no Radix would fail for nothing — and here it PASSED
  only because a stale `package.json` entry survived from the old
  hardcoded-install behaviour while the export imports no Radix at all. A check
  that passes on a stale artifact is worse than no check.

## Output

- `src/components/shell/` (one file per component in the export).
- `src/kit/` when the export ships `design-system/kit/`.
- `src/routes/__root.tsx` rewritten.
- `src/styles.css` rewritten clean.
- `package.json` gains whatever the copied files import and it lacked.
- `.supertools-state/03-shell.json` receipt.
- Raw artifacts under `.supertools-state/03-shell/`:
  - `__root.tsx.before.txt`, `styles.css.before.txt` — pre-patch snapshots
  - `patch-summary.json`, `verify-output.log`

## Idempotency

Re-runnable. setup.mjs overwrites the shell and kit files (canonical source is
the export), installs only packages that are missing, and the styles.css
rewrite produces the same output each run. Demo retirement is stable: a file
already deleted stays deleted, a referenced one stays kept.

The module carries an entry-point guard, so importing it does not run a
scaffold as a side effect (authoring-checklist rule 15).

## Common failure modes

| Symptom | Fix |
|---|---|
| TS error on `navigate({ to: href })` — typed routes won't accept untyped strings | The template uses `href as never` to defeat strict literal typing. If your TS strict settings still complain, change to `href as unknown as never`. |
| `useNavigate` throws "no router context" | Wrapper is rendered above the router. It must live inside `<body>` after `Scripts` registers — check ordering in `__root.tsx`. |
| Wordmark click reloads instead of SPA navigating | `onNavigate` isn't being passed through. Confirm the chain `AppShellWrapper → AppShell → MainNav → wordmark <a>` in the components. |
