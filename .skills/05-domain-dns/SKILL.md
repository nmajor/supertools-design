---
name: 05-domain-dns
description: Lay the worker-independent DNS baseline for the project domain in Cloudflare — CAA records authorizing Cloudflare's SSL CAs. naked→www and the spec-site preview wildcard are recorded as Worker requirements for the ralph plan; the records that point at the Worker are created later by the deploy step.
---

# 05 — Domain DNS baseline

Configure the part of the Cloudflare zone that is stable and **doesn't depend
on the Worker existing yet**:

1. **CAA records** authorizing the full set of certificate authorities
   Cloudflare uses for Universal SSL — Let's Encrypt (`letsencrypt.org`),
   Google Trust Services (`pki.goog; cansignhttpexchanges=yes`), SSL.com
   (`ssl.com`), and Sectigo (`sectigo.com`) — for both `issue` and
   `issuewild` (8 records). The exact set is per Cloudflare's CAA docs; a
   *partial* set risks silently blocking issuance for a CA CF falls back to.
   The set lives in `caa-set.mjs`, consumed by both setup and verify so the
   promised and enforced sets can't drift.

## naked → www

Handled by the **Worker**, not a Cloudflare redirect rule. The CF token has
DNS edit (CAA works) but not Dynamic-Redirect/Rulesets edit, and a
worker-level 301 is more reproducible — no extra token scope, works on any CF
plan. This skill records the requirement to
`.supertools-state/ralph-requirements.json`; skill 22 (ralph-plan) folds it
into the implementation plan as an explicit task (the Worker 301-redirects the
apex host to `https://www.<domain>` preserving path + query, applied before
any auth/session logic).

## Boundary — what this skill deliberately does NOT do

The apex and `www` DNS records that resolve to the Worker are **created by
`wrangler deploy` as Worker custom domains** in the deploy step (skills 22/23).
The same goes for the spec-site preview wildcard (`*.<domain>` proxied record +
Worker route + router-level `X-Robots-Tag: noindex` — recorded as a second
ralph requirement, `preview-wildcard-serving`, per spec.md §4). Creating placeholder records here would conflict with
Cloudflare's custom-domain provisioning. So no `A` / `AAAA` / `www CNAME`
records are created here.

## Inputs

- `.supertools-state/00-prereqs.json` (status: ok)
- `.supertools-state/project.json` → `domain`
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

## Steps

1. ```sh
   node .skills/05-domain-dns/setup.mjs
   ```
   Resolves the zone, ensures the CAA record set (idempotent — skips ones
   already present with matching content), and records the naked→www Worker
   requirement to `ralph-requirements.json`.
2. ```sh
   node .skills/05-domain-dns/verify.mjs
   ```
   Confirms the CAA records resolve via the CF API and the naked→www
   requirement was recorded for the ralph plan.
3. Stage candidate at `.supertools-state/05-domain-dns.candidate.json`.
4. **In-line council** (`_shared/council.md`), then **collab review**
   (`node .skills/_collab-review/run.mjs 05-domain-dns`). Both must approve
   before renaming candidate → `.supertools-state/05-domain-dns.json`.

## Output

- 8 CAA records on the zone (issue + issuewild for letsencrypt.org,
  `pki.goog; cansignhttpexchanges=yes`, ssl.com, sectigo.com).
- A `naked-to-www-redirect` entry in `.supertools-state/ralph-requirements.json`.
- `.supertools-state/05-domain-dns.json` — receipt.
- Raw artifacts under `.supertools-state/05-domain-dns/`:
  - `zone-snapshot.json` — DNS records before/after
  - `setup-output.log`, `verify-output.log`

## Idempotency

Re-runnable. CAA records already present with matching content are skipped;
the ralph requirement is keyed by `(skillId, key)` and replaced in place
rather than duplicated.

## Common failure modes

| Symptom | Fix |
|---|---|
| `CF zone not found` | The domain isn't in the configured CF account, or the token lacks zone access. Re-check skill 00. |
| `CF create CAA … Authentication error` | The token lacks DNS edit on this zone. Widen it at https://dash.cloudflare.com/profile/api-tokens. |
