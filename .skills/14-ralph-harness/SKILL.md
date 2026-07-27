---
name: 14-ralph-harness
description: Vendor PageAI-Pro/ralph-loop and adapt it into a local, no-Docker, 3-agent-council build engine. Lays the .agent/ workspace, the de-dockerized CLI layer (claude/codex/gemini run natively, not via sbx), and two council drivers — plan-council (unanimous 3-agent plan approval) and build-council (Claude implements, Codex+Gemini review each task for correctness + integration). Builds the engine only; skills 15/16 drive it.
---

# 14 — Ralph Harness (no-Docker 3-agent council engine)

The reusable engine that skills 15 (plan) and 16 (build) drive. It adapts
`PageAI-Pro/ralph-loop` — a bash orchestrator that runs a fresh-context agent
per iteration against a file-based task list (`.agent/`), using `<promise>`
tags to signal progress. Upstream runs the agent inside a Docker Sandbox
(`sbx run <agent> .`) and ships **no review council**. We change exactly two
things:

1. **De-dockerize.** Replace `sbx run` with direct local CLI calls
   (`claude` / `codex` / `gemini`). Everything else — the `.agent/` layout, the
   `<promise>` protocol, the task schema — is preserved so upstream stays
   mergeable.
2. **Add a council.** A 3-agent **plan gate** (unanimous) and a 2-reviewer
   **build gate** (Codex + Gemini check every task for correctness, acceptance,
   and **integration with the rest of the app**) — the safety the lost sandbox
   used to provide is replaced by a per-task review gate + per-task commit on a
   `ralph/build` branch. The loop calls `ensure_clean_baseline()` first, folding
   any pre-existing dirty state into one labeled baseline commit so each task's
   diff/commit contains only its own work, and a task is finalized (`passes:true`)
   **only after** its commit actually lands (commit failure rolls the pass back).

This skill **builds and smoke-tests the engine**. It does no product work.

## Inputs

- `.supertools-state/00/01` receipts (status: ok)
- CLIs: `claude`, `codex`, `gemini`, `git`, `jq`, `node`

## What setup.mjs does

1. **Vendor** `PageAI-Pro/ralph-loop` → `.supertools-state/_cache/ralph-loop`
   (`ensureRepo`, portable). Copies its pure `promise.sh` (tag protocol)
   verbatim into the engine.
2. **Lay the engine** under `scripts/ralph-local/` (the de-dockerized drivers +
   lib) and the `.agent/` workspace: `PROMPT.md`, `STEERING.md`, **`DECISIONS.md`**
   (the baked project architecture — bindings, render pipeline, auth,
   deploy — so the council converges instead of re-deciding), `tasks.json=[]`,
   `planning-status.json` (`not_started`), and `prd/ tasks/ logs/ history/
   screenshots/ reviews/ council/`.
3. **Council prompts** in `.agent/council/`: `PLAN_GENERATOR.md`,
   `PLAN_REVIEWER.md`, `BUILD_TASK.md`, `CODE_REVIEWER.md`,
   `INTEGRATION_REVIEWER.md`, `FIX_REVIEW.md`.
4. **De-dockerized CLI layer** `scripts/ralph-local/lib/agents-local.sh`:
   - Claude: `claude -p --model opus --permission-mode bypassPermissions` (stdin)
   - Codex: `codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.5 -c model_reasoning_effort=high -` (stdin)
   - Gemini: `gemini -m gemini-2.5-pro -y -p …`
5. **Drivers**: `ralph-plan-council.sh` (generate → unanimous 3-agent review
   loop, ≤3 rounds → `planning-status.json=approved`) and `ralph-council.sh`
   (build loop: pick highest-priority `passes:false` task → Claude implements
   one → verify → Codex+Gemini parallel review → fix loop → `passes:true` +
   commit on `ralph/build`). Both preserve ralph's exit codes + `<promise>` tags.
6. **Playwright** (`@playwright/test` + chromium) for local UI verification —
   distinct from production Cloudflare Browser Rendering.
7. Best-effort push the **generic engine** (scripts + prompt templates, not
   the project's `DECISIONS.md`) to `supertools-stack` so it's reusable.

## Steps

1. ```sh
   node .skills/14-ralph-harness/setup.mjs
   ```
2. ```sh
   node .skills/14-ralph-harness/verify.mjs
   ```
   **Cheap end-to-end engine smoke** on a throwaway scratch repo (not the app):
   proves all 3 CLIs respond, the `<promise>` parser works, the **plan gate
   reaches unanimous approval**, the **build gate** runs an implement→review→
   commit cycle on a trivial task, and `BLOCKED`/exit-codes behave. The scratch
   repo is removed afterward; the real app tree is untouched.
3. Stage candidate, then **in-line council** + **collab review**
   (`node .skills/_collab-review/run.mjs 14-ralph-harness`). Both must approve.

## Output

- `scripts/ralph-local/` — the de-dockerized council engine (drivers + lib).
- `.agent/` — workspace skeleton + `DECISIONS.md` + council prompts +
  `planning-status.json` (`not_started`).
- `@playwright/test` + chromium installed (devDependency).
- `.supertools-state/14-ralph-harness.json` — receipt (vendored SHA, file list).

## Idempotency

Re-runnable. `ensureRepo` re-fetches; engine files + `.agent/` scaffold are
overwritten from templates; an **existing non-empty `tasks.json` or an
`approved` `planning-status.json` is preserved** (never clobbered) so re-running
the harness after planning doesn't wipe the plan.

## Common failure modes

| Symptom | Fix |
|---|---|
| `jq: command not found` | Install jq (the task-state lib needs it). |
| A CLI ping fails in verify | Authenticate that CLI (`claude`, `codex`, `gemini`) non-interactively first. |
| Plan/build gate hangs | A sub-agent is waiting on input — confirm each CLI runs non-interactively in bypass/yolo mode. |
