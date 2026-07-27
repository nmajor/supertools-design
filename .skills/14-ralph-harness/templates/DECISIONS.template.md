# __BRAND_NAME__ — Locked Build Decisions

This file is **binding architecture** for the plan generator and every build
task. The council treats it as settled: a task that contradicts a decision here
is rejected rather than debated. Fill every section before running skill 15
(ralph-plan) — the plan council reads this first.

See `DECISIONS.example.md` in this folder for a fully worked example of the
level of detail expected.

> **UNFILLED** — skill 15 refuses to run while this marker is present. Delete
> it once every section below is answered.

## Product (see design/product-plan/)

- What the product does, in two sentences:
- The single primary conversion action:
- What a user gets that they cannot get elsewhere:

## Stack (already scaffolded — skills 00–13)

- Framework / hosting:
- Anything the scaffold set up that the build must NOT change:

## Cloudflare resources / bindings

- D1 databases:
- R2 buckets:
- KV namespaces:
- Queues / Durable Objects / cron triggers:

## Auth

- Who can sign in, and at what point in the funnel:
- What is gated behind auth vs. open:

## Core pipeline

- The main server-side workflow, step by step:
- External APIs it depends on, and the failure behaviour of each:
- Anything to PORT from an existing proof-of-concept (set `PLAN_POC_DIR`):

## Secrets / config

- Secrets the Worker needs at runtime (names only — never values):
- Which are sandbox vs. live for the first deploy:

## Deploy

- Target domain (apex + `www` as Worker custom domains):
- What must be true before the first live deploy:

## Out of scope (do NOT add tasks for these)

-

## Honor the existing ralph-requirements

`.supertools-state/ralph-requirements.json` accumulates requirements recorded
by earlier skills (redirects, webhook handlers, cron heartbeats). Every entry
there must become a task. Do not restate them here — they are read directly.
