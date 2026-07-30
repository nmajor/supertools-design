---
name: 01-project-init
description: Scaffold the TanStack Start + CF Workers app in-place over the existing project root by running supertools-stack/install.sh, preserving research/, design/, docs/, CLAUDE.md, .env, and .skills/.
---

# 01 — Project init

Lay down a runnable TanStack Start + CF Workers scaffold at the project root,
without disturbing the research, design, and docs already present. The skill
is a thin wrapper around `supertools-stack/install.sh` — **whatever
install-steps that repo ships at the time of the run are what ends up in the
project.** This skill deliberately does not list them: the stack repo owns
that list and changes it independently. Read it from the source of truth
instead — `ls scripts/install-steps/*.mjs` in the stack checkout, or the
Status section of the stack repo's README.

The scaffolder refuses to write into a non-empty directory, so the strategy
is: run it into a fresh tmp dir, then rsync the result back with anchored
excludes for every preserved path plus `--ignore-existing`.

## Stack source

**`github.com/nmajor/supertools-stack` is the canonical source.** The skill
clones it (`_shared/repos.mjs`) and runs `install.sh --no-refresh`. This skill
never commits or pushes to the stack repo.

`$SUPERTOOLS_STACK_DIR` (else `../supertools-stack`) overrides the clone when
set, for local stack development. It is an override, not a preference — an
unset `$SUPERTOOLS_STACK_DIR` is the normal case and is not a degraded one.

The receipt records which source was used, its SHA, and whether the working
tree was dirty.

> **Do not enumerate what the scaffold contains here.** The scaffold is
> whatever install-steps the stack repo ships at run time, discovered by its
> own `scripts/orchestrate-install.mjs` in numeric-prefix order. To see the
> current pipeline, ask the tree rather than this file:
> `ls scripts/install-steps/*.mjs` in the stack checkout.
>
> A previous version of this section claimed a local checkout was *preferred*
> because origin lagged it by 14 commits, and warned that cloning GitHub would
> "silently produce a far thinner scaffold." Origin has since caught up and
> that claim became actively harmful: an agent acting on it went looking for a
> local checkout that need not exist, and reported a non-existent blocker.
> Frozen "as of \<date\>" claims about another repo's contents go stale
> without any signal that they have.

## Protected from the merge

`CLAUDE.md`, `design/`, `docs/`, `research/`, `.env`, `.env.example`,
`.gitignore`, `.skills/`, `.supertools-state/`.

"Protected" means **the scaffold merge cannot touch them** — three layers:
each entry is excluded from rsync with a root-anchored pattern (the scaffold
can neither overwrite nor *add files inside* them), `--ignore-existing`
covers any other pre-existing file, and setup.mjs snapshots a manifest
(kind + **sha256 for plain files**) before the merge and fails loudly
**immediately after the rsync** if anything preserved is missing, changed
kind, or changed content.

**What the manifest actually proves is not uniform**, and receipts must not
blur it: plain files carry a sha256 and are content-verified, while
**directories are verified by kind and existence only** — the manifest stores
no recursive tree hash, so "the merge added nothing inside `design/`" rests on
the root-anchored rsync exclude, not on a hash. `merge-summary.json` records
`preservedHashedFiles` and `preservedKindOnlyDirs` separately so the
distinction survives into the receipt.

Protected ≠ immutable. The skill writes to some protected paths by design.
The scaffold-facing writes below all happen *after* the merge-integrity check,
so none can be confused with the merge touching a preserved path. The one
exception is `.supertools-state/`, the skill's own output directory, which is
written both before and after the check — see the note under the table.

| Protected path | Write | Why it is not a merge violation |
|---|---|---|
| `.gitignore` | appends env/build ignores | hardening; append-only |
| `.env.example` | creates it if absent | the protected exclude blocks the scaffold's copy; never overwrites an existing one |
| `docs/` | creates the directory if absent | a declared protected path the verifier asserts exists |
| `.supertools-state/` | receipts, manifests, logs | this is the skill's own output directory — it is on the protected list to stop the *scaffold* from writing there, not to stop the skill |

`.supertools-state/` is written **both before and after** the check: the
preserved manifest is snapshotted before the rsync, and the merge summary and
captured logs after. That is the intended behaviour, not an exception to it.

Protected paths this skill never writes: `CLAUDE.md`, `design/`, `research/`,
`.env`, `.skills/`.

`tsconfig.json` is also hardened (non-app folders appended to `exclude`), but
it is **not** a protected path — it is a scaffold file the skill owns.

Re-merge safety: an existing `drizzle/` dir is excluded wholesale from
re-runs — drizzle generates random migration filenames per scaffold, so a
re-merge would otherwise inject a duplicate initial migration under a new
name ("table already exists" on the next apply).

## Inputs

- `.supertools-state/00-prereqs.json` (status: ok)
- A local supertools-stack checkout via `$SUPERTOOLS_STACK_DIR` or `../supertools-stack` (or network access to GitHub as fallback)

## Steps

1. **Run setup** (idempotent — no-ops if a finalized receipt exists;
   `FORCE_REINIT=1` to re-scaffold):
   ```sh
   node .skills/01-project-init/setup.mjs
   ```
   Clones/resolves the stack, snapshots preserved files, runs `install.sh`
   into a scratch tmp dir, rsyncs back with the exclusions above, re-verifies
   the preserved manifest, delivers scaffold-only files the preserved-excludes
   blocked, repairs the stack's test tooling, runs `npm install`, then hardens
   `.gitignore` (env + build dirs) and `tsconfig.json` (excludes non-app
   folders, spliced surgically so JSONC comments survive).

### Repairs applied to the stack's output

A fresh scaffold fails this skill's own verifier at **18/23**. Five defects
cause it — **three in `supertools-stack`** (missing `vitest` dependency,
missing `test` script, unpatched auth test) and **two in this skill's own
protect/assert contract** (`.env.example` excluded rather than delivered,
`docs/` asserted but never provided). Setup repairs all five after the
merge-integrity check:

| Defect | Repair |
|---|---|
| vitest configs, vitest test files and `test:contract` / `test:auth` scripts, but **no `vitest` dependency** — every test target fails `vitest: not found`, which also fails `tsc --noEmit` with TS2307 | adds `devDependencies.vitest` (pinned in `setup.mjs` as `VITEST_RANGE`) |
| no `test` script at all, contradicting this file's claim that bare `npm test` is repointed at `test:contract` | adds `"test": "npm run test:contract"` |
| `.env.example` is on the PRESERVED list, so the rsync excludes it — a project that has none can never receive the scaffold's copy | copies it explicitly after the integrity check, never overwriting |
| `tests/20-auth/signup-flow.test.ts` POSTs with no `Origin` header, which Better Auth ≥1.4 rejects as CSRF (403 `MISSING_OR_NULL_ORIGIN`), failing both auth tests | adds `Origin: BASE` to the sign-up POST; if the headers aren't in the expected shape it logs a warning and leaves the file alone rather than guessing |
| **(this skill, not the stack)** `docs/` is a declared protected path the verifier asserts exists, but neither the project nor the scaffold necessarily provides one — the skill asserted a path it never delivered | creates the directory |

The three `supertools-stack` defects are repaired **locally only** — this skill
never commits or pushes to that repo, so a project scaffolding from upstream
will hit them again until they are fixed there.

`tsconfig.json` hardening appends to the existing `exclude` array in place
rather than reserializing the file. Three guards run before the write: the
result must re-parse to exactly the intended array, every other top-level key
must be unchanged, and no comment present in the original may be missing from
the result. Adversarial cases for the splice and the JSONC stripper live at
`.supertools-state/_review/tsconfig-splice-cases.mjs`.

`docs/` is likewise a declared PRESERVED path that neither the project nor the
scaffold necessarily provides, while the verifier asserts every PRESERVED entry
exists. Setup creates the directory so the contract is self-consistent.

These run **after** the preserved-manifest integrity check, so they can never
be mistaken for the merge touching a preserved path.
2. **Verify:**
   ```sh
   node .skills/01-project-init/verify.mjs
   ```
   Checks preserved + scaffold files exist, `npm run build`, `tsc --noEmit`,
   the contract suite, local D1 migrations, then boots `vite dev` on a free
   port and runs BOTH a GET / probe AND the live auth signup-flow suite
   against it (`BETTER_AUTH_TEST_BASE_URL`). All output is redacted via
   `_shared/redact.mjs`.

   Note: bare `npm test` is repointed at `test:contract` — the scaffold's
   original `vitest run` breaks on the CF vite plugin's `resolve.external`
   validation, and `test:auth` requires a live server (the verifier
   orchestrates it; manually: `npm run dev` + `npm run test:auth`).
3. **Stage candidate** at `.supertools-state/01-project-init.candidate.json`
   with the merge summary and verifier results.
4. **Council review** per `.skills/_shared/council.md`, then `_collab-review`.
   On both approvals, rename candidate → `.supertools-state/01-project-init.json`.

## Output

- Runnable scaffold at the project root (dev server, build, typecheck, tests green).
- `.supertools-state/01-project-init/merge-summary.json` + install log.
- Receipt at `.supertools-state/01-project-init.json`.

## Idempotency

- Finalized receipt present → setup no-ops (FORCE_REINIT=1 overrides).
- rsync `--ignore-existing` + anchored preserved excludes make a re-merge
  additive-only; npm install and the hardening steps are re-run-safe.

## Failure modes

| Symptom | Fix |
|---|---|
| `install.sh exited N` | Read `.supertools-state/01-project-init/install-output.log`; the stack's per-step receipts (in the tmp dir) let a re-run resume. |
| `Preserved-file integrity check failed` | Restore the named path from git, investigate the rsync excludes before re-running. |
| `npm run build` / `tsc` fail | Scaffold/tooling drift in supertools-stack — fix upstream in the local checkout, re-run with FORCE_REINIT=1 into a clean state. |
| `vite dev GET /` no 2xx | Check nothing else binds the chosen port; run `npx vite dev` manually to see startup errors. |
| `test:auth` 403 `MISSING_OR_NULL_ORIGIN` | Better Auth ≥1.4 requires an Origin header on POSTs; the test must send `Origin: BASE` (patched here 2026-07-03 — upstream to supertools-stack). |
| `db:migrate:local` "table already exists" | Duplicate randomly-named initial migration in `drizzle/` (e.g. from a re-scaffold merge). Keep only the migration named in `drizzle/meta/_journal.json`, delete `.wrangler/state`, re-apply. |
