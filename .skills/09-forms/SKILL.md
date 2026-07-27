---
name: 09-forms
description: Create Chatwoot API-channel inboxes for the contact + privacy webforms, wire owner + auto-assignment, and lay down working /api/contact and /api/privacy Worker routes that push submissions into Chatwoot. Adapted from the tmp privacy-form POC.
---

# 09 — Contact + privacy forms

Make the website's contact and privacy/data-rights forms actually deliver:
two Chatwoot **API-channel** inboxes plus the **Worker routes** that turn a
form POST into a Chatwoot conversation (contact → conversation → message).
After this skill the backend intake works; the implementation loop only has
to build the form *pages* that POST to these routes.

## Inputs

- `.supertools-state/00/01/08` receipts (status: ok)
- `.supertools-state/project.json` → `domain`
- `CHATWOOT_HOST`, `CHATWOOT_ACCESS_TOKEN`, `CHATWOOT_ACCOUNT_ID`

## What setup.mjs does

1. **Ensure two API-channel inboxes** — `Contact form` and `Privacy form`
   (channel type `api`) — reused by name. Captures each `inbox_identifier`.
2. **Owner membership + per-inbox auto-assignment** (active
   `conversation_created` rule assigning the owner; repaired on drift).
3. **Persist identifiers** to `.env`
   (`CHATWOOT_CONTACT_INBOX_IDENTIFIER`, `CHATWOOT_PRIVACY_INBOX_IDENTIFIER`)
   and to the Worker config: a `vars` block in `wrangler.jsonc` (committed —
   these are public-API identifiers, not secrets) plus `.dev.vars` for local
   `vite dev`. Regenerates `worker-configuration.d.ts` via `wrangler types`.
4. **Lay down the Worker code** (verbatim templates):
   - `src/lib/chatwoot-forms.ts` — submit helper (validation, honeypot,
     contact→conversation→message), reads `env` from `cloudflare:workers`.
   - `src/routes/api/contact.ts`, `src/routes/api/privacy.ts` — TanStack
     Start server routes (`createFileRoute(...).server.handlers.POST`).
5. **Record a ralph requirement** for the form *pages* (`/contact`,
   `/privacy`) that POST JSON `{ name, email, message, company? }` to these
   routes (`company` is the spam honeypot).

## Steps

1. ```sh
   node .skills/09-forms/setup.mjs
   ```
2. ```sh
   node .skills/09-forms/verify.mjs
   ```
   Confirms both API inboxes + identifiers, the env wiring (wrangler vars +
   .dev.vars + regenerated types), the route/lib files, `npm run build` +
   `tsc`, and a **live POST** to `/api/contact` and `/api/privacy` against
   `vite dev` returning `{ ok: true, conversationId }` (plus the honeypot
   returning `ok:true` with no conversation).
3. Stage candidate, then **in-line council** + **collab review**
   (`node .skills/_collab-review/run.mjs 09-forms`). Both must approve.

## Output

- Chatwoot `Contact form` + `Privacy form` API inboxes (owner-assigned).
- `src/lib/chatwoot-forms.ts`, `src/routes/api/{contact,privacy}.ts`.
- `wrangler.jsonc` vars + `.dev.vars` + regenerated `worker-configuration.d.ts`.
- `.env`: `CHATWOOT_CONTACT_INBOX_IDENTIFIER`, `CHATWOOT_PRIVACY_INBOX_IDENTIFIER`.
- A `contact-privacy-form-pages` ralph requirement.
- `.supertools-state/09-forms.json` — receipt.

## Idempotency

Re-runnable. Inboxes matched by name; identifiers refreshed; wrangler vars
upserted; route/lib files overwritten from templates (canonical source);
automations repaired on drift.

## Common failure modes

| Symptom | Fix |
|---|---|
| Live POST returns `ok:false, "Form intake is not configured."` | `.dev.vars` missing the identifiers, or `wrangler types` not regenerated. Re-run setup. |
| `tsc` error on `env.CHATWOOT_*` | `worker-configuration.d.ts` is stale — `npx wrangler types`. |
| POST 404 in dev | Route file naming — must be `src/routes/api/contact.ts` exporting `Route = createFileRoute('/api/contact')`. |
