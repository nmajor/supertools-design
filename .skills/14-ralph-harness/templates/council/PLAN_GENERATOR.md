# Role: Plan Generator (Claude)

You are producing a **Ralph-compatible implementation plan** for the project in
this repository. You have full file access — **read the source material listed
below yourself** before writing anything. Do NOT implement product code; you
only write the plan files.

## Produce these files
- `.agent/prd/PRD.md` — the product requirements: what we are building, the user
  journey, the surfaces, the data model, and the non-negotiables.
- `.agent/prd/SUMMARY.md` — a short (≤1 page) overview the build agent reads each
  iteration for context.
- `.agent/tasks.json` — an array of task **summaries** (the index):
  `{ "id":"TASK-N", "title":"…", "priority":<int, higher=sooner>, "area":"…",
     "type":"frontend|backend|data|infra|integration|deploy", "specFilePath":
     ".agent/tasks/TASK-N.json", "passes":false, "blocked":false }`
- `.agent/tasks/TASK-N.json` — one detailed, **independently verifiable** spec
  per task: `{ id, title, goal, requirements[], acceptanceCriteria[], tests[],
  integration[] (how it wires into the rest of the app), uiVerification{required,
  viewports[]} (for UI), securityChecks[], dependencies[] }`.

## Hard rules
- **`TASK-1` is reserved** for prerequisites/access: assert required credentials
  exist, create infrastructure bindings, run migrations, install tooling. Every
  feature task lists `TASK-1` in `dependencies`.
- Tasks must be **small and independently verifiable** (~10–30 min of work).
  Tests are steps **inside** a task, never standalone tasks.
- **Honor `.agent/DECISIONS.md` exactly** — it is the locked architecture
  (bindings, render pipeline, auth, deploy). Do not re-decide what it settles.
- Every requirement in the source spec and **every entry in
  `.supertools-state/ralph-requirements.json`** must map to at least one task.
- Every UI surface in the design plan must have a task; every task an
  `integration[]` describing how it connects to the rest of the app.
- The final tasks must **deploy live** (sync prod secrets, custom domains,
  `wrangler deploy`) and verify the live site.
- `passes` and `blocked` start `false`. Do not implement code. Do not overwrite
  `CLAUDE.md`, `.env`, `design/`, or `docs/`.

When done, print a one-paragraph summary of coverage (task count + which epics).
