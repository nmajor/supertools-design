# 50-domain

Configure DNS and routing for the project's domain.

> **Status: stub — not implemented in v0.1.**

## What this concern handles

Configures Cloudflare DNS and zone records for the domain, including the naked-domain → `www.` subdomain redirect.

## v0.1 behavior

When invoked by `/supertools-design:bootstrap`:

1. Print `stub: 50-domain — not implemented in v0.1`.
2. Write `<project>/.supertools-state/50-domain.json`:
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
