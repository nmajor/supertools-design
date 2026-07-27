---
name: 00-prereqs
description: Verify every credential, CLI, and domain access is present before any other skill in the pipeline runs.
---

# 00 — Prereqs

Fail loud if anything is missing. Every later skill assumes this passed.

## What this checks

- Every key in `requires.json` `envRequired` resolves in the **merged**
  environment (`.env` + machine env; machine wins on conflict — `loadEnv`
  never overrides process.env), which is exactly what later skills see. The
  env-keys row names any required key satisfied only by the machine env, so
  `.env` completeness is visible, never assumed. A missing `.env` is reported
  as a `[FAIL]` row (exit 1), not an unhandled crash.
- Required CLIs are on PATH: `node`, `npm`, `npx`, `claude`, `codex`, `gemini`.
  (Wrangler is invoked via `npx wrangler` later — no global install needed.)
- `claude -p`, `codex exec`, and `gemini -p` all round-trip.
- The Cloudflare PLATFORM token can read the project domain's zone.
- **Required API probes:** Ahasend, Polar **sandbox** (MoR payments),
  OpenRouter, DataForSEO, Chatwoot (platform + user tokens), MXroute
  DirectAdmin, Rybbit host reachability, Healthchecks.
- **Optional probes — run only when the keys are set** (every key in
  `envOptional`; blanks tolerated here, but named later skills hard-require
  them):
  - `CLOUDFLARE_SITES_ACCOUNT_ID`/`_API_TOKEN` — second account where customer
    websites ship: token active + account id distinct from the platform
    account. Required from `13-registrar-adapter` and tenant-serving work.
  - `CLOUDFLARE_SITES_R2_*` — real SigV4-signed S3 ListBuckets against the
    endpoint (tenant site storage). Required by the serving/publish skills.
  - `OPENAI_API_KEY`, `FIREWORKS_API_KEY` — aux/trial LLM providers for
    skill `10-llm-layer` (Fireworks serves `glm-5p2` for generation trials).
  - `PORKBUN_API_KEY`/`_SECRET_KEY` — registrar fallback for `13-registrar-adapter`.
- Rybbit host is reachable and `RYBBIT_API_KEY` has the expected `rb_*` site
  format (real validity is exercised in skill `07-analytics` when the snippet
  ships — Rybbit's admin API is session-cookie auth, so no bearer probe exists).

## Steps

1. **Confirm the project domain with the user**, then run setup to persist it.
   The default suggestion comes from `CLAUDE.md` ("Primary domain: …"). Once
   confirmed, write `.supertools-state/project.json`:
   ```sh
   # pass the user-confirmed domain explicitly:
   node .skills/00-prereqs/setup.mjs <domain>
   # …or, if CLAUDE.md already names it and the user agrees, no arg —
   # setup.mjs parses it from CLAUDE.md:
   node .skills/00-prereqs/setup.mjs
   ```
   setup.mjs is strictly idempotent: an existing `project.json` always wins —
   passing a different domain is refused unless `--force` is given (the domain
   is foundational; later skills' receipts key off it). It never invents a
   domain — if it can't resolve one it exits non-zero and asks you to pass it.
2. **Run the verifier.** From the project root:
   ```sh
   node .skills/00-prereqs/verify.mjs
   ```
   Each check prints `[OK ]` or `[FAIL]` with detail. Exit 1 means halt.
3. **If any check fails**, surface the specific failure and the fix
   (re-auth a CLI, widen the CF token's zone scope, add the missing env
   key). Do not proceed.
4. **Stage the candidate receipt** at `.supertools-state/00-prereqs.candidate.json`:
   ```json
   {
     "status": "ok",
     "version": "0.1",
     "timestamp": "<ISO8601 — actual time, not a placeholder>",
     "summary": "All credentials, CLIs, and domain access verified for <domain>.",
     "domain": "<value from project.json>",
     "checksPassed": <count>
   }
   ```
5. **Council review** per `.skills/_shared/council.md`. Pass the SKILL.md,
   `requires.json`, the candidate receipt, and the verifier's stdout as the
   review inputs. On `COUNCIL_APPROVED`, run `_collab-review`, then rename
   candidate → `.supertools-state/00-prereqs.json`.

## Output

- `.supertools-state/project.json` — `{ projectName, domain, domainSource, … }` (written by setup.mjs)
- `.supertools-state/00-prereqs.json` — receipt

## Secret safety

Every check name/detail passes through `redact()` before being stored or
printed — it strips every env-derived value from response bodies, URLs, and
exception messages. Coverage is BOTH the raw values written in `.env` AND the
effective process.env values for every key named in `requires.json` or
present in `.env` — so a `.env` credential shadowed by a machine-env override
is still redacted. Checks report key NAMES and verdicts only; no
value-derived fragments (not even prefixes).

Manual self-test (run any time):
```sh
AHASEND_ACCOUNT_ID=zzzz-echo-canary-zzzz node .skills/00-prereqs/verify.mjs 2>&1 | grep -c canary
# expect 0 — the ahasend probe FAILs but the injected value never appears
```

## Idempotency

Re-running this skill is safe. setup.mjs no-ops if `project.json` exists;
verify.mjs only reads `.env` and probes APIs — it never modifies the project.
The receipt is overwritten on each successful run.

## Common failure modes

| Symptom | Fix |
|---|---|
| `cf zone access (...) — Zone not in the platform CF account.` | The platform CF token's zone scope does not include this domain. Widen it at https://dash.cloudflare.com/profile/api-tokens ("All zones from an account"), or move the zone into the platform account. |
| `polar sandbox — HTTP 401` | Mint a sandbox org token at https://sandbox.polar.sh (org settings → access tokens). Use a **dedicated org for this product**, not another project's. |
| `dataforseo api — HTTP 401` | `DATAFORSEO_USERNAME`/`PASSWORD` wrong or absent from the machine env — re-export or add to `.env`. |
| `claude -p round-trip — ...` | Run `claude` once interactively to re-auth. |
| `gemini -p round-trip — 404` | The pinned model was retired; set `RALPH_GEMINI_MODEL` to a live model. |
