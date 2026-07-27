---
name: 13-uptime
description: Create the production heartbeat check in Healthchecks, persist its ping URL, lay down a /api/health liveness route, and record a ralph requirement for the cron-triggered heartbeat handler.
---

# 08 — Uptime (Healthchecks)

Set up dead-man's-switch monitoring: a Healthchecks check that alerts if the
Worker stops pinging. This skill creates the check and the liveness route;
the scheduled cron that actually pings is a ralph/deploy requirement (it's a
Worker `scheduled()` handler, coupled to the deploy).

## Inputs

- `.supertools-state/00/01` receipts (status: ok)
- `HEALTHCHECK_API_KEY`, `HEALTHCHECK_HOST`

## What setup.mjs does

1. **Ensure the check** `<projectName>-prod-heartbeat` (idempotent via
   Healthchecks' `unique:["name"]`). `timeout 3600s` / `grace 3600s`.
   Attaches notification channels (`channels:"*"`; override with
   `HEALTHCHECK_CHANNELS`) — setup **halts** if none attach.
2. **Pause the check.** The heartbeat cron only exists after deploy, so an
   armed check would false-alarm within timeout+grace. Healthchecks
   auto-resumes a paused check on its next real ping — production arms it
   automatically. PAUSED is the verified pre-deploy end-state; once production pings, up/grace are healthy and re-runs never pause a live check (manual_resume=false so pings auto-resume a paused check).
3. **Persist the ping URL as a secret.** The ping URL is a **spoof
   capability** (anyone holding it can fake heartbeats): it goes to `.env`
   (`HEALTHCHECK_PING_URL`, + `HEALTHCHECK_CHECK_SLUG`) and NOWHERE else —
   never logged, never in receipts, never in `wrangler.jsonc`. At deploy it
   becomes a Worker secret (`wrangler secret put HEALTHCHECK_PING_URL`), per
   the recorded ralph requirement. The verifier greps tracked files for the
   ping UUID and fails on any leak.
4. **Lay down `/api/health`** — a GET liveness route returning
   `{ ok: true, service, ts }` (used by the post-deploy smoke).
5. **Record the `cron-heartbeat` ralph requirement** — cron trigger +
   `scheduled()` handler + the secret, shipped together at deploy.

**Rotation:** `ROTATE_HEARTBEAT=1 node .skills/13-uptime/setup.mjs` deletes
and recreates the check (new ping UUID) — use whenever the ping URL may have
been exposed.

## Steps

1. ```sh
   node .skills/13-uptime/setup.mjs
   ```
2. ```sh
   node .skills/13-uptime/verify.mjs
   ```
   Confirms: the check exists, is configured (3600/3600, channel attached,
   slug), and its state is sane — `paused` (pre-deploy healthy), or `up`/`grace`
   (production healthy); only `new` fails (setup should have paused it). Verify
   never pings the check; arming is production's job. `manual_resume=false` is
   asserted so pings auto-resume a paused check; `HEALTHCHECK_PING_URL` + `CHECK_SLUG` are in
   `.env`; **no ping-endpoint leak** — the ping HOST (matches current and
   rotated-away stale URLs on any Healthchecks URL shape) appears in no
   git-tracked file nor this skill's state artifacts (filenames-only
   reporting); the `cron-heartbeat` requirement carries the wrangler-secret
   posture; `/api/health` exists and returns `{ok:true}` under `vite dev`;
   `npm run build` + `tsc` pass. All output redacted via `_shared/redact.mjs`
   (check slug excluded as deliberately non-secret).
3. Stage candidate, then **in-line council** + **collab review**
   (`node .skills/_collab-review/run.mjs 13-uptime`). Both must approve.

## Output

- Healthchecks check `<projectName>-prod-heartbeat` — configured;
  `paused` pre-deploy (auto-armed by the first production ping,
  `manual_resume=false`), `up`/`grace` once production pings.
- `src/routes/api/health.ts`.
- `.env`: `HEALTHCHECK_PING_URL` (secret-class), `HEALTHCHECK_CHECK_SLUG`.
  Nothing in `wrangler.jsonc`; the Worker gets the URL via
  `wrangler secret put` at deploy (ralph requirement `cron-heartbeat`).
- `.supertools-state/13-uptime.json` — receipt (never contains the ping URL).

## Idempotency

Re-runnable. The check is `unique` by name (no duplicates); pause is
re-run-safe; the ping URL is re-persisted; the route is overwritten from the
template. `ROTATE_HEARTBEAT=1` is the deliberate non-idempotent escape hatch.

## Common failure modes

| Symptom | Fix |
|---|---|
| `HC create check failed (401/403)` | `HEALTHCHECK_API_KEY` lacks write scope — use a read-write project API key. |
| `HC pause failed` | Older Healthchecks may lack the pause endpoint — upgrade, or pause manually in the UI before re-running verify. |
| `check state sane` fails with status=new | Setup should have paused it — re-run setup. NEVER manually pause an `up`/`grace` check: those mean production is pinging and pausing would silence real alerting. If something pinged a pre-deploy check unexpectedly, investigate what holds the URL and consider `ROTATE_HEARTBEAT=1`. |
| `no ping-endpoint leak` fails | A tracked file or state artifact contains the ping host — remove/redact it (values must live only in `.env` / deploy-time secret), regenerate `worker-configuration.d.ts` if it was the leak, re-run. |
