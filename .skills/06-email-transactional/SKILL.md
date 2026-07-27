---
name: 06-email-transactional
description: Register email.<domain> with Ahasend for transactional email, write the required SPF/DKIM/DMARC TXT records plus the return-path CNAME to Cloudflare, wait for validation, mint a domain-scoped send key (persisted as a fingerprint-bound trio: key + id + sha256 fingerprint), send a test email, and persist AHASEND_FROM_* + the send-key trio to .env.
---

# 06 — Transactional email (Ahasend)

Set up a dedicated transactional-email subdomain (`email.<domain>`) on Ahasend
and validate it end-to-end. This is the path the platform uses for lead
notifications, auth emails (password reset), customer onboarding, and the
weekly analytics report.

Adapted from a proven prior implementation onto this project's `_shared/`
helpers (`ahasend.mjs`, `cf.mjs`, `env.mjs`); git history carries lineage.

## Why a subdomain

Ahasend recommends a dedicated subdomain so transactional reputation is
isolated from any general-domain email. `email.<domain>` is the convention
(override with `EMAIL_DOMAIN` for a full custom domain, or `EMAIL_SUBDOMAIN`
for a different label).

## Envelope: From + Reply-To (no no-reply)

Transactional mail sends **From** a warm branded sender on the isolated send
subdomain (`<Brand Name> <hello@email.<domain>>` — brand derived from CLAUDE.md's `Brand:` line, title-cased project name as fallback) with **Reply-To** the root
support mailbox (`support@<domain>`, provisioned by skill 07 → routed into
Chatwoot). We deliberately avoid `no-reply@`: replies to lead notifications, onboarding
emails, and weekly reports are real customer/support requests and must reach
a human. The envelope is persisted
(`AHASEND_FROM_EMAIL`, `AHASEND_REPLY_TO`) and recorded as a ralph
requirement so the Worker's real sends use the same envelope.

## Inputs

- `.supertools-state/00-prereqs.json`, `.supertools-state/05-domain-dns.json` (status: ok)
- `.supertools-state/project.json` → `domain`
- `AHASEND_API_KEY`, `AHASEND_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- A test recipient (CLI arg → `TEST_INBOX` env → defaults to `nick@nmajor.com`)

## What setup.mjs does

1. Looks up or creates the Ahasend domain `email.<domain>`.
2. Finds the Cloudflare zone for `<domain>`.
3. Adds the DNS records from Ahasend's response: every record Ahasend marks
   `required` (currently 3 TXT — DKIM at `ahasend._domainkey`, SPF at the
   subdomain apex, DMARC at `_dmarc`) **plus** the return-path CNAME
   (`psrp → rp.ahasend.com`, for bounce handling + DMARC alignment). The
   record set is read from the API response, not hardcoded, so it tracks
   whatever Ahasend returns. Tracking / media / subscription / MX records are
   intentionally skipped. Skips records already present with matching content;
   **halts on a conflict** (same name+type, different content).
4. Polls Ahasend until `dns_valid: true` (15-min timeout — DNS propagation can
   take a few minutes for a fresh subdomain).
5. **Mints a narrow `messages:send` API key scoped to `email.<domain>`** and
   persists it as `AHASEND_SEND_API_KEY` **plus `AHASEND_SEND_API_KEY_ID`**
   (the pair is load-bearing: reuse is BIND-VERIFIED — the persisted id must
   resolve to an account key whose scope set is EXACTLY the wanted single
   scope, and the secret↔id link is proven by a MINT-TIME FINGERPRINT:
   `AHASEND_SEND_API_KEY_FPR = sha256(secret)` is persisted when the pair is
   born together, and reuse requires the recomputed hash to match — send
   keys cannot self-identify and the provider's `last_used_at` updates too
   lazily to bind behaviorally. A missing or mismatched fingerprint halts
   setup). The
   `AHASEND_SECRET_KEY` in `.env` is the management key; it cannot and
   should not send. **Never destructive:** if same-label keys exist that
   this machine cannot bind to (no matching `_ID` in `.env`), setup HALTS
   with a conflict — they may be a deployed Worker's live key. Re-run with
   `FORCE_REMINT_SEND_KEY=1` to delete + re-mint deliberately (then update
   the Worker secret immediately).
6. Sends the test email from `hello@email.<domain>` using the minted send key.
7. Writes `AHASEND_FROM_EMAIL`, `AHASEND_FROM_DOMAIN`, `AHASEND_REPLY_TO`,
   and the send-key trio `AHASEND_SEND_API_KEY` + `AHASEND_SEND_API_KEY_ID` + `AHASEND_SEND_API_KEY_FPR`
   to `.env` idempotently on EVERY successful run (mint or bind-verified
   reuse) — this also covers .env recovery when a valid pair arrives via the
   machine environment.

Prints a `---SETUP_DONE---` JSON block with the email domain, from-address,
Ahasend domain id, and test-send details.

## Steps

1. ```sh
   node .skills/06-email-transactional/setup.mjs [test-recipient-email]
   ```
2. ```sh
   node .skills/06-email-transactional/verify.mjs
   ```
   Re-fetches the Ahasend domain, confirms `dns_valid: true`.
3. Stage candidate at `.supertools-state/06-email-transactional.candidate.json`.
4. **In-line council** then **collab review**
   (`node .skills/_collab-review/run.mjs 06-email-transactional`). Both must
   approve before finalizing the receipt.

## Output

- Ahasend domain `email.<domain>`, dns_valid.
- DNS records in the Cloudflare zone: 3 required TXT (DKIM/SPF/DMARC) + return-path CNAME.
- A `messages:send`-scoped Ahasend API key for the domain.
- `AHASEND_FROM_EMAIL=hello@email.<domain>`, `AHASEND_FROM_DOMAIN=email.<domain>`,
  `AHASEND_REPLY_TO=support@<domain>`, and the send-key trio
  `AHASEND_SEND_API_KEY` + `AHASEND_SEND_API_KEY_ID` +
  `AHASEND_SEND_API_KEY_FPR` (sha256 of the secret, minted together) in `.env`.
- A `transactional-email-envelope` entry in `ralph-requirements.json`.
- `.supertools-state/06-email-transactional.json` — receipt.
- Raw artifacts under `.supertools-state/06-email-transactional/`:
  - `ahasend-domain.json` — sanitized allowlisted domain artifact (id, domain, dns_valid, created_at, updated_at) — the raw provider object carries account metadata and is deliberately NOT persisted
  - `setup-output.log`, `verify-output.log`

## Idempotency

Re-runnable. Existing Ahasend domain → reused. DNS records present with
matching content → skipped. A test email is sent on every run (intentional —
proves the path works). `.env` writes are idempotent.

## Common failure modes

| Symptom | Fix |
|---|---|
| `Ahasend already has N key(s) labeled ... cannot bind` | A deployed Worker may be using that key. Restore the full trio (AHASEND_SEND_API_KEY + _ID + _FPR) to .env, or FORCE_REMINT_SEND_KEY=1 to rotate (then update the Worker secret). |
| `CF token doesn't have DNS access` | Widen the token's zone scope (skill 00 covers this). |
| `DNS conflict` | A same-name+type record exists with different content. Resolve in the CF dashboard, then re-run. |
| `DNS propagation timeout (15 min)` | Re-run later; propagation can lag for fresh subdomains. |
| `Ahasend create send key failed (403 ...)` | The management key lacks `api-keys:write` (needed to mint the send-scoped key) — this fails at the minting step, before any send. Add `api-keys:write` to the management key, or paste an existing single-scope send key manually: set `AHASEND_SEND_API_KEY`, its key id as `AHASEND_SEND_API_KEY_ID`, **and** compute the fingerprint yourself — `node -e 'console.log(require("crypto").createHash("sha256").update(process.env.AHASEND_SEND_API_KEY).digest("hex"))'` — into `AHASEND_SEND_API_KEY_FPR` (all three required; setup halts without the fingerprint). |
| `Test email send failed (403 ...)` | The minted/provided SEND key lacks `messages:send` for this domain (wrong domain scope, or revoked). Clear the trio (`AHASEND_SEND_API_KEY`/`_ID`/`_FPR`) and re-run to mint fresh. |
| `Persisted send key ... is OVER-SCOPED` | The bound key carries extra scopes beyond `messages:send:{email.<domain>}` — not the narrow key this skill promises. Delete it (or clear the env pair) and re-run to mint a single-scope key. |
| `Test email send failed` | Surface the Ahasend API error; check the account isn't sending-suspended. |
