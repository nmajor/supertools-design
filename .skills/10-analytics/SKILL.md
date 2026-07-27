---
name: 10-analytics
description: Resolve the project's Rybbit site id, embed the Rybbit tracking script in the root layout, and lay down a typed event-taxonomy module (src/lib/analytics.ts) derived from the product funnel.
---

# 10 — Analytics (Rybbit)

Wire privacy-friendly analytics: embed the Rybbit tracking script site-wide
and give the app a single typed surface for the funnel's custom events.

## Site id — discover or create

The Rybbit tracking script identifies a site by a **numeric `data-site-id`**
(not the `rb_` API key — that's the data API token). setup resolves it
automatically:

1. Read the org's sites (`GET /api/organizations/{org}/sites` with the `rb_`
   key) and find the one whose `domain` matches the project domain.
2. If found, use its numeric `siteId`.
3. If **not found, create it** via `POST /api/organizations/{org}/sites`
   (`{ domain, name }`) — the `rb_` key authenticates on this org-admin route.
4. Persist `RYBBIT_SITE_ID` to `.env`.

## Inputs

- `.supertools-state/00/01/04` receipts (status: ok)
- `.supertools-state/project.json` → `domain`
- `RYBBIT_HOST`, `RYBBIT_API_KEY`

## What setup.mjs does

1. Resolve the Rybbit `site_id` for the domain (discover-or-halt, above).
2. **Embed the tracking script** in `src/routes/__root.tsx` `<head>`
   (marker-guarded, idempotent):
   `<script src="<RYBBIT_HOST>/api/script.js" data-site-id="<id>" defer />`.
   The host + id are public (they ship to the browser), so they're inlined.
3. **Write `src/lib/analytics.ts`** — the event taxonomy + a typed `track()`
   wrapper over `window.rybbit.event()`. Pageviews are automatic via the script.
4. Persist `RYBBIT_SITE_ID` to `.env`.

> **Ordering note:** skill `04-logo` owns `__root.tsx` and rewrites it wholesale.
> Run 10 after 04. If 04 is ever re-run, re-run 10 to re-inject the script.

## Steps

1. ```sh
   node .skills/10-analytics/setup.mjs
   ```
2. ```sh
   node .skills/10-analytics/verify.mjs
   ```
   Confirms the site id resolves, the script tag is in `__root.tsx` with the
   right host + id, `analytics.ts` exports the taxonomy + `track`, and
   `npm run build` + `tsc` pass.
3. Stage candidate, then **in-line council** + **collab review**
   (`node .skills/_collab-review/run.mjs 10-analytics`). Both must approve.

## Output

- Rybbit script embedded in `__root.tsx`.
- `src/lib/analytics.ts` (event taxonomy + `track()`).
- `.env`: `RYBBIT_SITE_ID`.
- `.supertools-state/10-analytics.json` — receipt.

## Idempotency

Re-runnable. Site id re-resolved (reused from `.env`/Rybbit); the script tag
is marker-guarded; `analytics.ts` overwritten from the template.

## Common failure modes

| Symptom | Fix |
|---|---|
| `Rybbit create site failed (403/401)` | The `rb_` key lacks org-admin rights. Use a key with site-management scope, or create the site once in the dashboard (setup will then discover it). |
| Script present but no data in Rybbit | `data-site-id` must match the dashboard site; confirm `RYBBIT_SITE_ID`. Pageviews only fire from the real domain (localhost may be filtered). |
| `tsc` error on `window.rybbit` | `analytics.ts` declares the global; ensure it's imported somewhere or kept in the build. |
