---
name: 07-email-mailboxes
description: Provision MXroute mailboxes for support@ and privacy@ on the root domain, mirror the authoritative MX/SPF/DKIM/DMARC into Cloudflare, and persist the mailbox passwords. Inbound side of email — skill 08 (Chatwoot) connects to these mailboxes over IMAP/SMTP.
---

# 07 — Inbound mailboxes (MXroute)

Set up the **inbound** half of email: real mailboxes for `support@<domain>`
and `privacy@<domain>` on MXroute, plus the DNS that makes the root domain
receive mail. Skill 08 wires Chatwoot to these over IMAP (fetch) + SMTP
(agent replies); skill 09 routes the contact/privacy webforms through them.

## Email architecture (how the two email skills fit)

- **`email.<domain>` → Ahasend** (skill 06): transactional *sending* (receipts,
  pack-ready). Reputation-isolated on the subdomain.
- **`<domain>` root → MXroute** (this skill): inbound mailboxes for
  `support@` / `privacy@`. Distinct names, no DNS conflict with skill 06.

## Authoritative DNS, not guessed

Mail DNS is unforgiving, so nothing here is guessed:

- **MX** (`10 <server>`, `20 <server-relay>`) and **SPF**
  (`v=spf1 include:mxroute.com -all`) and **DMARC** — verified against
  multiple live MXroute domains on this account.
- **DKIM** — read per-domain from DirectAdmin's own zone
  (`CMD_API_DNS_CONTROL`, the `x._domainkey` TXT) after the domain is created.
  Never hardcoded.

## Inputs

- `.supertools-state/00-prereqs.json`, `.supertools-state/05-domain-dns.json` (status: ok)
- `.supertools-state/project.json` → `domain`
- `MXROUTE_SERVER`, `MXROUTE_USERNAME`, `MXROUTE_API_KEY` (DirectAdmin derives from these)
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

## What setup.mjs does

1. **Ensure the DirectAdmin domain** for `<domain>` on MXroute. If DA demands
   ownership proof, it adds the verification TXT to Cloudflare, waits for it
   to resolve, and retries.
2. **Ensure mailboxes** `support@` and `privacy@`. Passwords come from
   `MXROUTE_SUPPORT_PASSWORD` / `MXROUTE_PRIVACY_PASSWORD` if set, else a
   strong password is generated and persisted to `.env` (skill 08 needs them
   for IMAP/SMTP). On a pre-existing mailbox with no stored password, the
   password is reset so `.env` stays authoritative.
3. **Read DKIM** from DirectAdmin for the domain.
4. **Mirror DNS into Cloudflare** (root zone): MX ×2, SPF TXT, DMARC TXT,
   DKIM TXT. Idempotent: exact matches skipped. Conflict handling is
   purpose-aware — a differing SPF only conflicts with another SPF, DMARC
   with DMARC, DKIM with any differing TXT at the `_domainkey` name; unrelated
   TXT at the apex (e.g. a site-verification token) is left alone. After
   ensuring the two MX records, any **foreign MX** at the apex halts the run
   (a stale MX would split inbound mail) for manual resolution.

## Steps

1. ```sh
   node .skills/07-email-mailboxes/setup.mjs
   ```
2. ```sh
   node .skills/07-email-mailboxes/verify.mjs
   ```
   Confirms both mailboxes exist (DA), the DNS resolves publicly, DKIM is
   present, and an IMAP login succeeds for each mailbox.
3. Stage candidate, then **in-line council** + **collab review**
   (`node .skills/_collab-review/run.mjs 07-email-mailboxes`). Both must
   approve before finalizing.

## Output

- DirectAdmin domain + `support@` / `privacy@` mailboxes on MXroute.
- Cloudflare root DNS: MX ×2, SPF, DMARC, DKIM.
- `.env`: `MXROUTE_SUPPORT_PASSWORD`, `MXROUTE_PRIVACY_PASSWORD`.
- `.supertools-state/07-email-mailboxes.json` — receipt.
- Raw artifacts under `.supertools-state/07-email-mailboxes/`:
  - `da-dns.json` — the DirectAdmin zone read (DKIM source)
  - `cf-records.json` — records ensured in Cloudflare
  - `setup-output.log`, `verify-output.log`

## Idempotency

Re-runnable. Domain/mailbox creation no-op when present. DNS exact matches
skipped. Passwords reused from `.env` when present.

## Common failure modes

| Symptom | Fix |
|---|---|
| `You do not own that domain` on first run | Expected — setup creates it. If creation needs ownership proof, it adds the TXT + waits automatically. |
| `DNS conflict for TXT ...` | A differing SPF/DMARC/DKIM already exists at that name. Resolve in the CF dashboard, then re-run. |
| IMAP login fails in verify | Mailbox password in `.env` is stale. Delete the `MXROUTE_*_PASSWORD` line and re-run setup to reset it. |
| `DA DNS read failed` / no DKIM | DirectAdmin hadn't generated the DKIM yet. Re-run after a minute. |
