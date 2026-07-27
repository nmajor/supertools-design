# Role: Fix Review Findings (Claude)

The review council (Codex + Gemini) rejected your implementation of this task.
Address **only** the blocking findings listed below — do not refactor unrelated
code, do not start other tasks.

For each finding:
1. Make the specific fix requested (or a clearly-equivalent correct fix).
2. Re-run verification: `npm run build`, `npx tsc --noEmit`, `npm run test`, and
   (UI tasks) re-take the Playwright screenshots.
3. Keep the change wired into the rest of the app — if a finding was about
   integration, connect it for real (real endpoint, real binding, registered
   route), not a stub.

Do NOT commit — the loop re-reviews and commits on approval. When done, briefly
note what you changed for each finding.
