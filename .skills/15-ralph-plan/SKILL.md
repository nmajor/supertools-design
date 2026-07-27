---
name: 15-ralph-plan
description: Drive the harness's plan-council to generate the canonical implementation task list (.agent/prd/PRD.md, SUMMARY.md, tasks.json, tasks/TASK-*.json) from the design product-plan + the PoC + the accumulated ralph-requirements + the baked DECISIONS, then gate it behind UNANIMOUS approval from a 3-agent council (independent Claude reviewer + Codex + Gemini). On approval, writes planning-status.json=approved. verify.mjs independently audits coverage; the human reviews tasks.json before skill 16 builds.
---

# 15 — Ralph Plan (generate + unanimously council-approve the task list)

This is the highest-stakes skill: the task list is where functionality holes
seep in. It drives `scripts/ralph-local/ralph-plan-council.sh` (built by skill
14) to turn the product sources into a rock-solid, independently-verifiable
Ralph task plan, gated behind a **unanimous 3-agent council**.

## Inputs (the source bundle the generator reads)

- `design/product-plan/**` — the 5 sections (landing, style-quiz,
  style-directions, your-pack, my-boards) + shell + design-system + data-shapes
  + per-section `types.ts`/`tests.md` + instructions.
- `docs/00-product-spec.md` — the operative product spec.
- `$PLAN_POC_DIR` (optional) — a working PoC to PORT for the
  resource-generation core (supplied via `.agent/plan-sources.txt`, NOT hardcoded
  in the generic engine).
- `.supertools-state/ralph-requirements.json` — the 8 accumulated worker
  requirements from skills 05–13.
- `.agent/DECISIONS.md` — the locked architecture (bindings, render pipeline,
  auth, deploy) the council must honor and not re-decide.
- current `src/` inventory + `.env` **key names** + `wrangler.jsonc` vars.

## What setup.mjs does

1. Preconditions: skill 14 receipt present (engine laid); `.agent/` workspace +
   `planning-status.json` exist.
2. Write `.agent/plan-sources.txt` — the extra (out-of-repo) sources, i.e. the
   PoC path. The driver appends these to its project-relative defaults.
3. Run `bash scripts/ralph-local/ralph-plan-council.sh`:
   - **Generator** (Claude opus) reads the bundle and writes `.agent/prd/PRD.md`,
     `SUMMARY.md`, `tasks.json`, and one `tasks/TASK-*.json` per task.
   - **Unanimous 3-agent review** (independent Claude + Codex gpt-5.5 high +
     Gemini 2.5-pro) in parallel; any rejection → the generator revises (≤3
     rounds); reviews archived to `.agent/reviews/`.
   - On unanimous `PLAN_APPROVED` → `planning-status.json=approved`. On
     non-convergence → `changes_requested` + blocker summary (skill fails).

> Long-running (the generator writes ~120–160 task files; reviewers read the
> whole bundle). Run setup.mjs in the background and monitor its log.

## Steps

1. ```sh
   node .skills/15-ralph-plan/setup.mjs    # long — runs the plan-council
   ```
2. ```sh
   node .skills/15-ralph-plan/verify.mjs
   ```
   Independently audits the approved plan (backstop to the council): status
   approved; schema-valid non-empty `tasks.json`; every task has
   acceptance + tests + integration notes and a real spec file; `TASK-1` is
   prereqs/access; **coverage** of all 8 ralph-requirements, the 5 sections +
   shell, the resource-gen sub-epic (≥4 tasks), auth, and a deploy/cutover task;
   the 3 approval receipts are archived. Prints the full task list.
3. Stage candidate, then in-line council + collab review
   (`node .skills/_collab-review/run.mjs 15-ralph-plan`). Both must approve.
4. **Human review:** read `.agent/tasks.json` + the printed list before skill 16.

## Output

- `.agent/prd/PRD.md`, `.agent/prd/SUMMARY.md`, `.agent/tasks.json`,
  `.agent/tasks/TASK-*.json` — the approved plan.
- `.agent/planning-status.json` = `approved`.
- `.agent/plan-sources.txt`, `.agent/reviews/PLAN-*` (gitignored transcripts).
- `.supertools-state/15-ralph-plan.json` — receipt.

## Idempotency

Re-runnable. Re-running regenerates + re-reviews the plan (the generator
overwrites the plan files; reviewers re-judge). An already-approved plan is
re-derived, not assumed.

## Common failure modes

| Symptom | Fix |
|---|---|
| `planning-status` ends `changes_requested` | Council didn't converge in 3 rounds — read `.agent/reviews/PLAN-*`; tighten `DECISIONS.md` or the generator prompt, then re-run. |
| Generator wrote too few tasks | Reviewers should reject for coverage; if not, the verify coverage audit will fail — inspect and re-run. |
| A reviewer CLI errors mid-run | Re-run; the council is idempotent. |
