# Authoring a concern

A **concern** is a self-contained module of the bootstrap pipeline. Each concern handles one logical area (prereqs, database, auth, payments, etc.). Concerns live in `concerns/<NN-name>/`, where `NN` is a 2-digit numeric prefix that determines run order.

## Anatomy

Every concern folder has four files:

- `SKILL.md` — the intent prompt. Describes *what state should exist after this concern runs*, not literal commands. Followed by Claude when the orchestrator invokes the concern.
- `verify.mjs` — a programmatic smoke test. Exit 0 = pass, non-zero = fail. **Never ask Claude to verify; this script does it.**
- `requires.json` — declared dependencies and provided capabilities:
  ```json
  {
    "name": "string",
    "requires": ["other-concern-name"],
    "envRequired": ["VAR_NAME"],
    "provides": ["capability-name"]
  }
  ```
- `README.md` — human-readable purpose, one paragraph.

## Receipt contract

After a successful run, the orchestrator writes a receipt at `<project>/.supertools-state/<concern-name>.json` based on what the concern's `SKILL.md` returned. Every receipt has at least:

```json
{
  "status": "ok" | "stub" | "skipped",
  "version": "<concern's own version string>",
  "timestamp": "<ISO8601>",
  "summary": "<one-line summary>"
}
```

Concerns may add concern-specific fields (e.g. `databaseId`, `zoneId`, `repoUrl`). Declare them in `SKILL.md` so reviewers know what to expect.

## The "ensure" pattern

Every `SKILL.md` must follow this shape:

1. **Read state** — what's already done? (Existing receipt, env vars, file presence, real CLI checks like `wrangler whoami`.)
2. **If state matches goal** — no-op, write the receipt with a summary like `"already in place"`, exit.
3. **If not** — perform the missing work.
4. **Re-check state** to confirm.
5. **Write the receipt.**

This makes the concern safely re-runnable.

## Probe, don't ask

For prerequisite checks and post-conditions, run real shell commands or HTTP probes. Examples:

- `wrangler whoami` → confirms Wrangler login.
- `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/zones?name=<domain>` → confirms the CF token has zone-read on the right zone.
- `gh auth status` → confirms `gh` is authenticated.

Don't ask Claude "do you think this token works?" Run the probe and check the exit code.

## Adding a new concern

1. Pick a numeric prefix that fits the run order. Convention: leave gaps (10, 20, 30…) so you can insert without renumbering. `00` is reserved for prereqs; `99` for the final deploy step.
2. Create the four files above.
3. If the concern depends on others, list them in `requires.requires`.
4. Test idempotency: run it twice and confirm the second run no-ops.
5. The orchestrator picks it up automatically — no need to edit `commands/bootstrap.md`.

## Replacing a concern

Forking a concern is fine. To swap an implementation (e.g. one email provider for another):

1. Replace the contents of the concern folder.
2. Bump the `version` string in the receipt schema so existing project receipts get re-evaluated next run.
3. Document the swap in the concern's `README.md`.

## v0.1 stubs

Every concern in the v0.1 scaffold is a stub: `SKILL.md` writes a `"status": "stub"` receipt and returns; `verify.mjs` is a one-line `process.exit(0)`. The orchestrator can walk the entire pipeline against stubs to validate ordering and resumability before any real implementation lands.
