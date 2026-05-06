# 80-email

Set up transactional email.

> **Status: stub — not implemented in v0.1.**

## What this concern handles

Sets up Ahasend for transactional emails.

## v0.1 behavior

When invoked by `/supertools-design:bootstrap`:

1. Print `stub: 80-email — not implemented in v0.1`.
2. Write `<project>/.supertools-state/80-email.json`:
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
