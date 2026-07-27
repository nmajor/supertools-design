---
name: 16-ralph-build
description: Run the harness build-council loop to implement the approved 35-task plan end-to-end and deploy live to the project domain. Each task is implemented by Claude Opus, then reviewed by Codex + Gemini (correctness + acceptance + integration) before its per-task commit on the ralph/build branch. Guarded: refuses to run unless the plan is approved and FAL_API_KEY + OPENAI_API_KEY are present. Long-running, real API cost, live deploy.
---

# 16 — Ralph Build (council build loop → live)

Drives `scripts/ralph-local/ralph-council.sh` (built by skill 14) over the
approved plan (skill 15). Per iteration: pick the highest-priority
`passes:false` task → **Claude Opus** implements only it (reading `DECISIONS.md`
+ `SUMMARY.md` + the task spec) → verify (`build`, `tsc`, `vitest`, Playwright
for UI) → **Codex + Gemini** review the diff for correctness + acceptance +
**integration with the rest of the app** → fix loop → on both-approve, mark
`passes:true` and commit on the `ralph/build` branch. Aborted/rejected attempts
are stashed (never swept into history). Ends when all tasks pass and the app is
deployed live.

## Preconditions (hard gates)

- `15-ralph-plan` receipt present and `.agent/planning-status.json` = `approved`.
- **`FAL_API_KEY`** (fal.ai images) and **`OPENAI_API_KEY`** (OpenAI gpt-4o LLM)
  present in `.env` — the resource-generation tasks BLOCK without them. (These
  match the PoC's own providers: `openai` + fal.ai.)

## What setup.mjs does

1. Enforce the preconditions above (BLOCK with a clear message if unmet).
2. Generate `BETTER_AUTH_SECRET` into `.env` if absent, and mirror
   `FAL_API_KEY` + `OPENAI_API_KEY` + `BETTER_AUTH_SECRET` into `.dev.vars` so
   the Worker runtime sees them during the loop's local verification (`.dev.vars`
   is gitignored). The build's `TASK-1` wires the remaining secrets/bindings.
3. Run `bash scripts/ralph-local/ralph-council.sh` to completion. The final
   tasks (TASK-32/33) sync prod secrets, add the custom domains, and
   `wrangler deploy` to the **live project domain**.

> ⚠️ Long-running (hours): 35 tasks × implement→review→commit. Real cost
> (~$0.13/preview, ~$0.31/pack while testing the generation tasks). Serves the
> **live** domain. `BLOCKED`/`DECIDE` promises surface to the operator; steer
> mid-run via `.agent/STEERING.md`.

## Steps

1. ```sh
   node .skills/16-ralph-build/setup.mjs    # long — runs the build loop to live
   ```
2. ```sh
   node .skills/16-ralph-build/verify.mjs
   ```
   Asserts every task `passes:true`; a `<promise>COMPLETE</promise>` was emitted;
   `wrangler deployments list` shows a live deploy; and the apex + `www`
   hosts respond.
3. Stage candidate, then in-line council + collab review
   (`node .skills/_collab-review/run.mjs 16-ralph-build`).

## Output

- The fully implemented app on the `ralph/build` branch (one commit per task).
- Cloudflare D1/R2/KV/Queues/Browser-Rendering bindings created + wired.
- Live deploy at the project domain (sandbox payments; everything else real).
- `.supertools-state/16-ralph-build.json` — receipt.

## Idempotency

Re-runnable. Already-`passes:true` tasks are skipped; the loop resumes the
`ralph/build` branch without resetting it and continues the remaining tasks.

## Common failure modes

| Symptom | Fix |
|---|---|
| `BLOCKED: … no diff / review` on a task | Read `.agent/reviews/<TASK>-CODE-REVIEW-*`; the attempt is stashed. Fix the spec/DECISIONS or unblock the cause, then re-run (resumes). |
| `wrangler` auth/permission error in deploy tasks | Ensure `CLOUDFLARE_API_TOKEN`/account id are valid for Workers + the zone. |
| Generation task fails on API auth | `FAL_API_KEY`/`OPENAI_API_KEY` invalid or not in `.dev.vars` — re-run setup to re-mirror. |
