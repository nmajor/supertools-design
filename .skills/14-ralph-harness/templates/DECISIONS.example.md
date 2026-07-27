# <Brand> — Locked Build Decisions (EXAMPLE)

> This is the reference implementation's filled-in DECISIONS file, kept as a
> worked example of the level of detail the build council needs. Your project's
> real decisions go in `.agent/DECISIONS.md` (scaffolded from
> `DECISIONS.template.md`). Do not ship this file as-is.

This file is **binding architecture** for the plan generator and every build
task. Do not re-decide what is settled here. If something genuinely cannot work
as described, raise `DECIDE` — do not silently diverge.

## Product (see design/product-plan/ + docs/00-product-spec.md)
A wedding-aesthetic AI generator. Anonymous visitor takes a 4-step visual quiz
→ sees 3 generated style **directions** → pays once (Base $19 / Premium $39) →
receives a **pack of 6 Pinterest-pinnable artifacts** (moodboard, palette,
floral, decor, invitation, style-summary card) → can return to a **dashboard**
of past packs. Funnel surfaces: `/` `/quiz` `/directions` `/pack` `/boards`
plus existing `/contact` `/privacy-request` `/terms` `/privacy` `/refund`.

## Stack (already scaffolded — skills 00–13)
TanStack Start · React 19 · Vite 8 · Tailwind 4 (CSS `@theme`, tokens already
wired) · Cloudflare Workers (`wrangler`). Brand/logo/OG, shell, DNS/CAA,
Ahasend email, MXroute + Chatwoot, forms (`/api/contact`,`/api/privacy`),
Rybbit analytics (`src/lib/analytics.ts`), legal pages, Polar **sandbox**
products, Healthchecks heartbeat are all DONE. Reuse them; do not rebuild them.

## Cloudflare resources / bindings (TASK-1 creates these)
- **D1** — `users/sessions/accounts/verifications` (Better Auth) + `quiz_sessions`,
  `directions`, `orders`, `packs`. Use **Drizzle ORM** + migrations.
  - `packs.status` is an enum: `picker | rendering | delivered | refining | refunded`
    (the `refining` state is required — the UI shows a distinct refining screen).
  - `packs` must retain **refinement history**: the count used, the tier cap
    (1 Base / 3 Premium), and the **R2 keys of prior renders** (don't overwrite —
    keep each render so a refinement is additive and auditable).
- **R2** — generated PNG artifacts (tiles + 6 pins per pack) + direction previews.
- **KV** — cache StyleDirection JSON by intake hash (dedupe re-rolls).
- **Queues** — a producer enqueues a render job; a **Queue consumer** runs the
  ~90s pipeline (consumers allow long wall-clock; the request path does not).
  The frontend polls a D1-backed status endpoint.
- **Browser Rendering** binding — used **inside the queue consumer** to
  screenshot pins.

## Auth (Better Auth on D1) — reconciled with "no email gate before payment"
- Quiz + directions are **anonymous**, keyed to an anon-session cookie.
- Payment via **Polar** collects the email. The `order.paid` webhook marks the
  `Order` **paid**, grants pack access (mints the signed pack-access token), and
  creates the `packs` row in **`picker`** state. **It does NOT enqueue a render.**
- **PAY-THEN-PICK (load-bearing):** the buyer unlocks all 3 directions by paying,
  then **picks one direction on `/pack`** (the picker state). **That pick — and
  only that pick — enqueues the render job** for the chosen direction. The PRD,
  the webhook task, and the `/pack` task must all state this identically; any doc
  that says render enqueues on `order.paid` is wrong.
- `/pack` is reachable immediately post-checkout via the **signed pack-access
  token** — no login wall on the magic moment.
- **Better Auth (magic-link via Ahasend)** is only for returning to `/boards`;
  `/boards` shows packs where `order.email == session.user.email`. A
  post-purchase email invites the buyer to claim their boards.

## Pack pipeline — PORT the PoC at /home/coder/random/veilboard-poc/poc/
- Port, do not redesign. LLM = **OpenAI gpt-4o** (StyleDirection +
  copy, structured tool-use); images = **fal.ai FLUX.2 [pro]**. Port the prompts
  (`poc/prompts/*.md`), `tiles.py:build_prompt`, and the 6 Jinja2 templates
  (`poc/templates/*.html`) → TS render functions screenshotted by Browser
  Rendering at **1000×1500**.
- **Cost split (protect margins):**
  - *Pre-payment (~$0.13/quiz):* generation **starts when the quiz is submitted**
    and **backs the Quiz Step-4 ~75s narrated screen** — the real palette streams
    mid-generation and the real style name typewriter-reveals near the end, then
    continues seamlessly into `/directions`. **This is the real generation job,
    not a fixed timer** (a timer that ignores real progress is a silent-completion
    failure). Produces 3 StyleDirections + **1 hero tile each** → a **600×900**
    moodboard preview per direction, stored in D1/R2 keyed to the anon quiz
    session. Drives `/directions` (1 watermarked preview shown, 2 "locked" but
    real underneath — NOT blurred).
  - *Post-payment (~$0.31/pack):* the direction **the buyer picks on `/pack`**
    (pay-then-pick) → 5 more tiles + copy → all 6 pins → R2. The pack row moves
    `picker → rendering → delivered` as the queue consumer works.
- **Cohesion:** hero generated first; its fal URL passed as
  `reference_image_urls` to the other tiles. **Determinism:**
  `master_seed = sha256(intake)[:31bits]`; per-tile `master_seed + i`;
  refinement re-roll `master_seed + 100*n`. Refinements: 1 (Base) / 3 (Premium).

## Secrets / config
- **NEW secrets required (must be in `.env` before the build loop):** `FAL_API_KEY`,
  `OPENAI_API_KEY`. Also generate `BETTER_AUTH_SECRET`.
- Reuse existing `.env`: Ahasend send key + from/reply-to, Chatwoot tokens +
  inbox identifiers, Rybbit site id, Healthchecks ping URL, Polar **sandbox**
  token + product ids + webhook secret.
- Production: `wrangler secret put` for every secret; public config as
  `wrangler.jsonc` vars. **Never commit `.env`.**

## Deploy (straight to live veilboard.com)
Final tasks: sync prod secrets; set Polar `success_url`/webhook to prod URLs;
add `veilboard.com` + `www.veilboard.com` as Worker **custom domains**;
implement the **naked→www 301** in the Worker before routing; add the cron
trigger + `scheduled()` heartbeat; `wrangler deploy`; verify live TLS + redirect
+ `/api/health`. Payments stay on **sandbox** keys — that is the only non-prod
setting.

## Out of scope (do NOT add tasks for these)
SEO style-landing pages, the free palette tool, the blog / Pinterest publishing
engine. Filing the Pinterest API app is a manual user action, not a build task.

## Honor the existing ralph-requirements
Every entry in `.supertools-state/ralph-requirements.json` (naked→www redirect,
transactional email envelope, Chatwoot widget, contact/privacy form links, Polar
checkout + webhook, cron heartbeat, the PoC reference) must become real tasks.
