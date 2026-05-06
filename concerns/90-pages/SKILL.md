# 90-pages

Generate placeholder pages and the SEO wrapper.

> **Status: stub — not implemented in v0.1.**

## What this concern handles

Generates placeholder pages: a blank home; a footer linking to placeholder Terms, Privacy, and Resources pages; one example placeholder resource page; and a reusable SEO wrapper component (headers + JSON-LD metadata) used by resource pages.

## v0.1 behavior

When invoked by `/supertools-design:bootstrap`:

1. Print `stub: 90-pages — not implemented in v0.1`.
2. Write `<project>/.supertools-state/90-pages.json`:
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
