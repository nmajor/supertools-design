# 00-prereqs

Verify prerequisites before bootstrapping.

> **Status: stub — not implemented in v0.1.**

## What this concern handles

Verifies the prerequisites every project needs: the domain is purchased on Cloudflare; `gh` CLI is authenticated; required API keys (Cloudflare, Rybbit, Ahasend) are present and pass smoke tests. Missing keys are collected from the user and written safely to the project's `.env` (which must be gitignored).

## v0.1 behavior

When invoked by `/supertools-design:bootstrap`:

1. Print `stub: 00-prereqs — not implemented in v0.1`.
2. Write `<project>/.supertools-state/00-prereqs.json`:
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
