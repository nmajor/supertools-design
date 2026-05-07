# 80-email

Set up Ahasend for transactional email and verify the domain end-to-end.

## What this concern handles

Registers `email.<root-domain>` with Ahasend; writes the required SPF, DKIM, DMARC, and return-path DNS records to the project's Cloudflare zone; waits for the domain to validate at Ahasend; sends a test email; and writes `AHASEND_FROM_EMAIL` and `AHASEND_FROM_DOMAIN` to the project's `.env`.

## Prerequisites

- The project's `.env` (or process env) must contain:
  - `AHASEND_API_KEY` (typically set by `00-prereqs`)
  - `AHASEND_ACCOUNT_ID`
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
- `<project>/.supertools-state/project.json` must contain `domain` (the root domain). Created by the bootstrap orchestrator.

If any are missing, halt and tell the user which one.

## Step 1: Resolve test recipient

Ask the user: "What email address should I send the test message to?" Suggest the user's `gh api user --jq .email` output as a default if available. Wait for confirmation.

## Step 2: Run setup

From `<project>/`:

```bash
node .supertools/concerns/80-email/setup.mjs <test-recipient-email>
```

The script:

1. Looks up or creates the Ahasend domain `email.<root-domain>`. (Override the subdomain by setting `EMAIL_SUBDOMAIN` in `.env`.)
2. Finds the Cloudflare zone for `<root-domain>` in the configured account.
3. Adds each *required* DNS record from Ahasend's response (DKIM CNAME, SPF TXT, DMARC TXT, return-path CNAME). Skips records that already exist with matching content. **Halts on conflicts** — if a same-name+type record exists with different content, the user must resolve manually.
4. Polls Ahasend until `dns_valid: true` (timeout 15 min). DNS propagation can take several minutes; longer is normal for new domains.
5. Sends the test email from `hello@email.<root-domain>` to the chosen recipient.
6. Writes `AHASEND_FROM_EMAIL` and `AHASEND_FROM_DOMAIN` to `.env` (idempotent — preserves existing keys).

The script prints a JSON summary block after `---SETUP_DONE---` containing `emailDomain`, `fromAddress`, `ahasendDomainId`, `testEmailSentTo`, `testEmailSentAt`. Capture these for the receipt.

If the script exits non-zero, halt and surface the error. The user can re-run after fixing — every step is idempotent.

## Step 3: Verify

From `<project>/`:

```bash
node .supertools/concerns/80-email/verify.mjs
```

Re-fetches the Ahasend domain and confirms `dns_valid: true`. Exits 0 on success.

## Step 4: Write the receipt

Write `<project>/.supertools-state/80-email.json` using the JSON summary captured in Step 2:

```json
{
  "status": "ok",
  "version": "0.2",
  "timestamp": "<ISO8601 now>",
  "summary": "<emailDomain> set up at Ahasend; required DNS records added in CF; test email sent to <testEmailSentTo>.",
  "emailDomain": "<emailDomain from setup output>",
  "fromAddress": "<fromAddress from setup output>",
  "ahasendDomainId": "<ahasendDomainId>",
  "testEmailSentTo": "<testEmailSentTo>",
  "testEmailSentAt": "<testEmailSentAt>"
}
```

## Idempotency

- Existing Ahasend domain → re-uses it; doesn't recreate.
- DNS records already present with matching content → skipped.
- Conflicting DNS records (same name+type, different content) → script halts; user resolves manually.
- A test email is sent on every setup run (intentional — proves the path is working).
- Once the receipt exists, the bootstrap orchestrator skips this concern entirely on re-runs.

## Failure modes

- **Missing env var** → halt, name the missing var. (Exit code 2.)
- **Ahasend create-domain fails** → halt with API error.
- **Cloudflare zone for root domain not found in this account** → halt; the domain isn't in the configured CF account.
- **DNS conflict** → halt; user resolves manually.
- **DNS propagation timeout (15 min)** → halt; user re-runs later.
- **Test email send fails** → halt; surface the API error.

## Why a subdomain (`email.<root>`)

Ahasend recommends a dedicated subdomain so transactional reputation is isolated from any marketing or general-domain email. `email.<root>` is the convention.
