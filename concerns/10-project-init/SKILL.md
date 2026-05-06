# 10-project-init

Initialize the project skeleton.

> **Status: stub — not implemented in v0.1.**

## What this concern handles

Initializes the project skeleton: installs Wrangler, runs `wrangler init`, and creates the GitHub repo via `gh`.

## v0.1 behavior

When invoked by `/supertools-design:bootstrap`:

1. Print `stub: 10-project-init — not implemented in v0.1`.
2. Write `<project>/.supertools-state/10-project-init.json`:
   ```json
   {
     "status": "stub",
     "version": "0.1",
     "timestamp": "<ISO8601 now>",
     "summary": "stub: not implemented in v0.1"
   }
   ```
3. Return without doing any real work.

The verifier (`verify.mjs`) is a no-op stub that exits 0 — the receipt is the source of truth for v0.1.

See `docs/authoring-a-concern.md` for how this stub will be filled in.
