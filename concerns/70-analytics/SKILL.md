# 70-analytics

Smoke-test the Rybbit analytics API key.

## What this concern handles

This v0.2 scope is intentionally narrow: confirm the Rybbit API key is recognized by the configured Rybbit host. The full analytics integration (event taxonomy, SDK setup, server-side tracking helpers) is not yet implemented and will be added in a later version.

## Prerequisites

- The project's `.env` (or process env) must contain:
  - `RYBBIT_API_KEY` (set by `00-prereqs`)
  - `RYBBIT_HOST` (set by `00-prereqs`)

If either is missing, halt and tell the user which one.

## Step 1: Run verifier

From `<project>/`:

```bash
node .supertools/concerns/70-analytics/verify.mjs
```

The script POSTs a benign event to `<RYBBIT_HOST>/api/track` and confirms the response is not `401` / `403`. Any other status (200, 4xx-with-validation-error, 5xx) means the API key was at least accepted by Rybbit's auth layer.

## Step 2: Write the receipt

Write `<project>/.supertools-state/70-analytics.json`:

```json
{
  "status": "ok",
  "version": "0.2",
  "timestamp": "<ISO8601 now>",
  "summary": "Rybbit API key smoke-tested OK against <RYBBIT_HOST>; full analytics integration deferred."
}
```

## Idempotency

The verifier is read-only-ish (POSTs a probe event with an intentionally-invalid `site_id` — Rybbit's handling of unknown sites determines whether the probe is recorded or dropped). It can be re-run any number of times.
