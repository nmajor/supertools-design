# Skill-authoring checklist

Hard-won rules from real council/collab rejections in THIS project (00, 01,
05, 13). Read before authoring or porting any skill; reviewers enforce these
as standards, so skipping one costs review rounds. Each rule names the skill
whose review taught it.

## Artifacts & receipts

1. **Always capture `setup-output.log` and `verify-output.log`** under
   `.supertools-state/<id>/` — reviewers reject runs whose claimed steps have
   no captured evidence. Use `>|` (zsh noclobber blocks `>`). *(05)*
2. **Receipts never overclaim.** Say exactly what THIS run demonstrated —
   "created:8" vs "present, skipped:8 on the captured idempotent re-run" are
   different claims; if the log shows a re-run, describe both runs. Record
   every flag the SKILL.md promises (source SHA, dirty flag, …). *(01, 05)*
3. **Keep a `reviewFixes` array in the candidate receipt** — reviewers use it
   to verify the fix trail, and it prevents re-litigating settled findings.

## Secrets & leak hygiene

4. **Classify every value before it exists**: is it a credential OR a
   *capability* (ping URLs, webhook URLs, signed URLs — anything whose
   possession grants an action)? Capability ⇒ secret-class: `.env` +
   `wrangler secret put` at deploy; NEVER in logs, receipts, summaries,
   wrangler.jsonc vars, or generated files (`worker-configuration.d.ts`
   embeds plaintext vars!). *(13)*
5. **Redaction by construction**: route every check name/detail through
   `_shared/redact.mjs` at the single `pass()/fail()` push point. No
   value-derived fragments — not even prefixes (`key.slice(0,6)` was a
   rejection). Non-secret env values (e.g. a public slug) go in the
   redactor's explicit exclude list, with a comment owning the call. *(00)*
6. **Leak scans must be**: host/shape-based (catch rotated-away STALE values,
   not just the current one), regex-anchored so docs naming a vendor host
   don't false-positive, RECURSIVE over the whole `.supertools-state` tree,
   and run over `git ls-files --cached --others --exclude-standard` (tracked
   AND untracked). Filenames-only reporting. *(13, three rounds)*
7. **On any exposure: rotate the capability AND purge artifacts** (recursive,
   shape-based scrub — exact-string replace misses reformatted echoes), then
   rotate again AFTER the scrub if reviewers saw the value. *(00, 13)*
8. **Reviewer prompts state the secret-hygiene rule inline** (they already do
   via council.md/review-prompt.md — don't strip it when customizing).

## External side effects

9. **Never arm anything production-shaped before production exists.**
   Monitors, alarms, countdowns, webhooks: create them DISARMED (paused,
   `manual_resume=false` so real traffic auto-arms) and make the verifier
   assert the disarmed state rather than exercising the live path. *(13)*
10. **Re-runs never degrade live systems**: state transitions are conditional
    (pause only `new` checks — never one that's `up`/`grace`). Verifiers
    accept every legitimate lifecycle state (`down` during an outage must not
    block a re-run) and fail only the truly-wrong state. *(13, two rounds)*
11. **Delete/overwrite legacy artifacts your rewrite obsoletes** (a stale
    `summary.json` from an earlier iteration got flagged as a leak). *(13)*

## Config & filesystem discipline

12. **Never parse/rewrite JSONC** (`wrangler.jsonc`, `tsconfig.json` when
    avoidable) — comments are documentation; wholesale rewrites are "left the
    project worse". Prefer not touching the file at all; if you must edit,
    splice surgically with a LINE-ANCHORED, COMMENT-AWARE match (a naive
    match hit the commented-out `"vars"` example and broke the build). *(13)*
13. **Preserved ≠ immutable — say which.** "Protected from the merge" is
    provable (snapshot manifest with **sha256 for files**, verified
    IMMEDIATELY after the merge, before any intentional hardening edits);
    "never touched" is falsified by your own hardening step. *(01)*
14. **Randomly-named generated files** (drizzle migrations) turn re-merges
    into duplicate-injectors — exclude such dirs wholesale once they exist,
    and document the "keep only what the journal names" recovery. *(01)*
15. **Entry-point guards** on any script another script imports
    (`import.meta.url === pathToFileURL(process.argv[1]).href`) — a bare
    top-level `main()` re-ran a full scaffold on import. *(01)*

## Verifier design

16. **Required probes never silently skip**: an empty host/key for a required
    service is a `[FAIL]` row, not an absent check. Optional key GROUPS are
    all-or-nothing — partial config fails naming the missing key NAMES;
    absent groups get an explicit informational row. *(00, two reviewers)*
17. **Probe exactly the thing under test** — readiness-poll `/api/health`,
    not `/` (a broken root route must not fail the health check). *(13)*
18. **Env checks verify against the MERGED environment** (machine env wins
    over `.env`; `loadEnv` never overrides) and NAME any required key that's
    machine-env-only. The redactor must cover raw `.env` values even when
    shadowed. *(00)*
19. **`.env` missing is a reported FAIL row + exit 1**, not an unhandled
    throw / exit 2. *(00)*
20. **Verify claims = verify scope.** If SKILL.md says "greps tracked files",
    the code must grep ALL of them — reviewers diff the claim against the
    loop bounds. *(13)*

## Docs

21. **SKILL.md is part of the implementation.** Every behavior change updates
    Steps, Output, Idempotency, AND the failure-mode table in the same edit —
    stale "what verify checks" text cost two full rounds. Failure-mode advice
    must be safe to follow blindly (an old row told operators to pause a
    live production check). *(13, two rounds)*
22. **Kill porting residue**: project names, old skill numbers, old paths —
    `grep -ri <source-project-name>` across the whole skill,
    including templates and generated files. *(13, _collab-review)*
23. **Never embed a brand value.** No colour, hex, font family, tagline,
    product description, or component list belongs in a skill. Read it from
    the Design OS export via `_shared/design-os.mjs` or from `project.json`
    via `_shared/project.mjs`; if the project supplies neither, fail loudly or
    omit the output — never substitute a plausible-looking default.
    **This binds verifiers too**: assert consistency with the project's own
    export, never a named font or hex. `02/verify.mjs` once asserted Fraunces
    and `--color-primary-900: #881337`, so it could only pass for the one
    brand it was written from, and every other project's correct tokens read
    as a failure. *(02/03/04, design-os-first refactor)*

## Process

24. **Run the lifecycle in order and let it catch you**: setup → verify →
    candidate → in-line council (≤3 rounds/cycle) → collab review → finalize.
    On rejection, fix the SKILL (not just the output) and re-enter at setup.
    Exercise every fix LIVE (force a re-run) — "the code now does X" without
    a captured run demonstrating X is an overclaim. *(01, 08)*
25. **Transient reviewer failures happen** (empty gemini stdout, codex CLI
    version drift after node switches — `npm i -g @openai/codex@latest &&
    asdf reshim nodejs`). Re-run the gate; don't mark unclear as approved.
