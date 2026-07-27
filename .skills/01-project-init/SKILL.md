---
name: 01-project-init
description: Scaffold the TanStack Start + CF Workers app in-place over the existing project root by running supertools-stack/install.sh, preserving research/, design/, docs/, CLAUDE.md, .env, and .skills/.
---

# 01 — Project init

Lay down a runnable TanStack Start + CF Workers scaffold at the project root,
without disturbing the research, design, and docs already present. The skill
is a thin wrapper around `supertools-stack/install.sh` — whatever
install-steps that repo ships at the time of the run are what ends up in the
project (as of 2026-07-03, v0.11: `00-scaffold`, `10-db` (D1 + Drizzle +
Better Auth schema + cascade contract test), `15-foundation` (env example,
logging, error pages, security headers), `20-auth` (Better Auth + sign-in/up),
`25-email` (Ahasend transport), `26-password-reset`, `27-auth-hardening`
(per-IP rate limit + Turnstile on /sign-up), `30-marketing`, `40-dashboard`,
`50-legal`).

The scaffolder refuses to write into a non-empty directory, so the strategy
is: run it into a fresh tmp dir, then rsync the result back with anchored
excludes for every preserved path plus `--ignore-existing`.

## Stack source (deliberate deviation from the original)

A **local checkout is preferred** (`$SUPERTOOLS_STACK_DIR`, else `../supertools-stack`)
over a GitHub clone: as of 2026-07-03 the local checkout carries 14 commits of
install-steps (v0.4–v0.11) that `origin/main` does not have, while origin only
adds ralph-harness commits. Cloning GitHub would silently produce a far
thinner scaffold. The receipt records the source, SHA, dirty flag, and the
divergence; **reconciling the two branches is a founder to-do**. On machines
without the local checkout, the skill falls back to a GitHub clone
(`_shared/repos.mjs`). `install.sh` runs with `--no-refresh` and this skill
never commits/pushes to the stack repo.

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

Protected ≠ immutable: AFTER the merge-integrity check passes, the skill
intentionally performs two documented hardening edits — appends env/build
ignores to `.gitignore` and patches `tsconfig.json` excludes. Nothing else
in the protected list is written by this skill.

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
   into a scratch tmp dir, rsyncs back with the exclusions above, runs
   `npm install`, hardens `.gitignore` (env + build dirs) and `tsconfig.json`
   (excludes non-app folders — rewrite drops JSONC comments, accepted
   trade-off), and re-verifies the preserved manifest.
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
