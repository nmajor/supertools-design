---
name: 11-legal-pages
description: Render /terms, /privacy, and /refund pages from token templates with the project's legal facts (operator, domain, emails, Merchant of Record, AI-opt-out, children, retention), each carrying a counsel-review banner. Replaces supertools-stack's stub 50-legal.
---

# 11 — Legal pages

Lay down the three policy pages the footer links — `/terms`, `/privacy`,
`/refund` — as real TanStack Start routes with content tailored to the
project's legal facts. supertools-stack's `50-legal` is an empty stub, so
this skill ships its own templates.

> **Not legal advice.** Each page carries a `have counsel review before
> launch` comment. The content is a sensible, fact-filled starting point — a
> lawyer must review before launch.

## Locked facts baked in (overridable via env)

| Token | Default | Env override |
|---|---|---|
| `BRAND` | from `CLAUDE.md` Brand line | — |
| `DOMAIN` | from `project.json` | — |
| `LEGAL_ENTITY` | `NMajor Studios LLC` | `LEGAL_ENTITY` |
| `ENTITY_JURISDICTION` | `a Wyoming, USA limited liability company` | `LEGAL_JURISDICTION` |
| `MOR` | `Polar (Polar Software Inc.)` | `MOR_NAME` |
| `PRICE_BASE` / `PRICE_PREMIUM` | `$19` / `$39` | `PRICE_BASE` / `PRICE_PREMIUM` |
| `PRIVACY_EMAIL` / `SUPPORT_EMAIL` | `privacy@`/`support@<domain>` | — |
| `EFFECTIVE_DATE` | today (ISO date) | — |

Policy decisions encoded in the copy: **Polar is Merchant of Record**
(billing, VAT, cooling-off); **we do not train AI on customer data**;
**no postal address published** — the two CCPA designated methods are
`privacy@<domain>` + the `/privacy-request` form; **children** under 13
(under 16 EU) excluded; **30-day retention, hard cascade-delete**; **EU
representative** left as a visible "not yet appointed" note + a TODO comment
(appoint before EU launch).

## Inputs

- `.supertools-state/00/01` receipts (status: ok)
- `.supertools-state/project.json` → `domain`; `CLAUDE.md` → brand

## Steps

1. ```sh
   node .skills/11-legal-pages/setup.mjs
   ```
   Renders `templates/{terms,privacy,refund}.tsx.tmpl` → `src/routes/`,
   substituting every `{{TOKEN}}`. Fails if any token is left unresolved.
2. ```sh
   node .skills/11-legal-pages/verify.mjs
   ```
   Confirms the three routes exist, **no `{{...}}` token survives**, each has
   the counsel-review banner + key clauses (MoR, AI-opt-out, children,
   retention, refund window), and `npm run build` + `tsc` pass.
3. Stage candidate, then **in-line council** + **collab review**
   (`node .skills/_collab-review/run.mjs 11-legal-pages`). Both must approve.

## Output

- `src/routes/terms.tsx`, `src/routes/privacy.tsx`, `src/routes/refund.tsx`.
- `.supertools-state/11-legal-pages.json` — receipt.

## Idempotency

Re-runnable. Pages are re-rendered from templates each run (canonical source).

## Common failure modes

| Symptom | Fix |
|---|---|
| `Unresolved token {{X}}` | A template token has no value. Add it to the config in `setup.mjs` or set the matching env var. |
| EU-representative still unnamed | Intentional until EU launch — the page shows a visible note + TODO comment, not a raw token. |
