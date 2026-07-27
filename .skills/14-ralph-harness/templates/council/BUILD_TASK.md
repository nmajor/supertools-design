> ⛔ **ONE TASK PER INVOCATION.** Implement exactly the task named in this
> invocation, verify it, and STOP. Do NOT start another task. Do NOT commit —
> the build loop commits after the review council approves.

## Overview
You are implementing the project described in `@.agent/prd/SUMMARY.md`. The
locked architecture is in `@.agent/DECISIONS.md` — follow it exactly; do not
re-decide bindings, render pipeline, auth, or deploy. Respect `@CLAUDE.md`.

## Before starting
Check `@.agent/STEERING.md` for any critical human override; do that first.
Read the last few entries of `@.agent/logs/LOG.md` for recent context.

## Task flow
1. Read the full spec at the task's `specFilePath`.
2. **Reuse before creating** — grep for existing utilities/components/routes
   (the repo already has shell, forms, analytics, legal, email/Chatwoot helpers
   from skills 00–13). Extend, don't duplicate.
3. Implement every requirement and acceptance criterion. Wire it in for real:
   register routes in the route tree, connect callbacks to real endpoints, fire
   the analytics events, persist to the real bindings. **No stubs, no TODOs, no
   mock data** standing in for the acceptance criteria.
4. Verify before claiming done:
   - `npm run build` and `npx tsc --noEmit` pass.
   - `npm run test` (vitest) passes; add/extend unit tests for new logic.
   - **UI tasks:** run a Playwright smoke test, check the console for errors,
     screenshot mobile (390×844) + desktop (1366×768) to
     `.agent/screenshots/<TASK-ID>-<viewport>.png`, and confirm the UI matches
     the design intent. Fix any unrelated breakage you caused.
5. Do NOT commit. Leave changes in the working tree for the review council.
6. End your response with exactly `<promise>TASK-{ID}:DONE</promise>` and stop.

## Help tags (use only after genuinely exhausting solutions)
- `<promise>BLOCKED:reason</promise>` — environment/credential/service dead-ends
  you cannot fix from here (missing API key, network policy, service outage).
- `<promise>DECIDE:question (A vs B)</promise>` — a product/architecture call not
  settled by the spec or DECISIONS.md.
