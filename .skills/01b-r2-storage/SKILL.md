---
name: 01b-r2-storage
description: OPTIONAL. Create the project's R2 bucket and its preview bucket, bind them in wrangler.jsonc, and prove the binding works with a real object round-trip. Skipped cleanly by projects that store no objects.
---

# 01b — R2 storage (optional)

Cloudflare R2 object storage for products that hold user uploads, generated
media, or any artifact too big for D1. **This skill is opt-in.** Nothing in the
00–17 chain depends on it, and a project that stores no objects should skip it
rather than create a bucket it never writes to.

Run it when the answer to "does this product put files somewhere?" is yes.

## Why it is its own skill

R2 is a *binding*, not a credential: once `wrangler.jsonc` declares it, the
Worker gets `env.MEDIA` with no key material anywhere in the codebase. That
makes it cheap to add correctly and annoying to add late — the binding name
ends up hardcoded across the app before anyone notices it should have been
configurable. Doing it right after `01-project-init` means the scaffold has a
storage binding from its first commit.

## What setup.mjs does

1. **Resolves names.** Bucket defaults to `<projectName>-media`, binding to
   `MEDIA`, both overridable with `R2_BUCKET_NAME` / `R2_BINDING`. A preview
   bucket (`<bucket>-preview`) is created alongside so `wrangler dev --remote`
   never writes into production data.
2. **Creates both buckets** via the Cloudflare API, idempotently — an existing
   bucket is adopted, not recreated, and never emptied.
3. **Splices `r2_buckets` into `wrangler.jsonc`.** Comment-aware and
   line-anchored per authoring-checklist rule 12: existing comments survive,
   a commented-out `r2_buckets` example cannot be matched, and the result is
   re-parsed and compared before it is written. An existing binding with the
   same name is left alone.
4. **Regenerates worker types** (`npm run cf-typegen`) so `env.<BINDING>` is
   typed. Failure here is a warning, not a halt — types are convenience.

## What it deliberately does NOT do

- **No S3 access keys.** The Worker binding needs none. Creating an S3 token
  "just in case" would mint a long-lived credential for a capability the
  product does not yet use. Projects that genuinely need off-Worker S3 access
  (an external render box, a CI uploader) should mint a scoped token then, and
  keep it in `.env` + `wrangler secret put` — never in `wrangler.jsonc`.
- **No lifecycle rules, CORS, or public access.** All three are product
  decisions with security consequences. Public bucket exposure in particular
  must be a deliberate act, never a scaffold default.

## Steps

```sh
node .skills/01b-r2-storage/setup.mjs      # R2_SKIP=1 to record a deliberate skip
node .skills/01b-r2-storage/verify.mjs
```

Then stage `.supertools-state/01b-r2-storage.candidate.json`, run the council
per `.skills/_shared/council.md`, and rename to `01b-r2-storage.json`.

## Verifier checks

- Both buckets exist in the account.
- `wrangler.jsonc` declares the binding, and its `bucket_name` /
  `preview_bucket_name` match the buckets that actually exist.
- Every comment present in `wrangler.jsonc` before the splice is still there.
- **A real object round-trip through the binding**: `wrangler r2 object put`,
  then `get` and byte-compare, then `delete`. Existence of a bucket proves
  nothing about whether the token can write to it — this is the check that
  does. The probe object uses a unique key under `__supertools-verify/` and is
  deleted afterwards; a failure to delete is reported, never ignored.
- If the receipt records a skip, the verifier asserts *no* R2 binding was
  added, so "skipped" cannot silently mean "half-configured".

## Idempotency

Re-runnable. Buckets are adopted if present, the `wrangler.jsonc` splice
no-ops when the binding already matches, and the verify probe cleans up after
itself.

## Failure modes

| Symptom | Fix |
|---|---|
| `create bucket … 403` | The CF token lacks **Workers R2 Storage: Edit**. Add it at https://dash.cloudflare.com/profile/api-tokens — the same token used for DNS does not include R2 by default. |
| `bucket name invalid` | R2 names are 3–63 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen. Override with `R2_BUCKET_NAME`. |
| round-trip `put` fails but the bucket exists | Almost always the token scope above. Bucket *listing* is a read permission; writing is separate. |
| binding already present with a different bucket | Left untouched by design. Reconcile by hand — silently repointing a binding is how production data gets orphaned. |
