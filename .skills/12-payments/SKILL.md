---
name: 12-payments
description: Create the Polar (sandbox) one-time products — `<Brand> Base` ($19) and `<Brand> Premium` ($39) — register the order webhook endpoint, and persist product ids + webhook secret. The checkout flow + webhook handler are recorded as ralph requirements (coupled to the order/pack state machine).
---

# 12 — Payments (Polar)

Set up the Merchant-of-Record side of payments on Polar (sandbox): the two
one-time products and the order webhook endpoint. The actual checkout
creation and webhook handling are part of the order/pack state machine the
implementation loop builds (from the PoC), so they're recorded as ralph
requirements rather than written here.

## Inputs

- `.supertools-state/00/05` receipts (status: ok)
- `POLAR_SANDBOX_ACCESS_TOKEN` (org-scoped — `organization_id` is inferred)
- `.supertools-state/project.json` → `domain` (for the webhook URL)

## What setup.mjs does

1. **Ensure products** (idempotent, matched by name):
   - `<Brand> Base` — one-time, **$19** (1900 ¢ USD)
   - `<Brand> Premium` — one-time, **$39** (3900 ¢ USD)
   Persists `POLAR_PRODUCT_BASE_ID` / `POLAR_PRODUCT_PREMIUM_ID` (+ price ids).
2. **Ensure the order webhook endpoint** at
   `https://<domain>/api/polar/webhook` for `order.paid` + `checkout.updated`.
   The signing secret is only returned at creation, so if the endpoint
   exists but no `POLAR_WEBHOOK_SECRET` is persisted, it is recreated to mint
   a fresh secret. Persists `POLAR_WEBHOOK_SECRET` + `POLAR_WEBHOOK_ENDPOINT_ID`.
3. **Record ralph requirements** for the checkout flow + webhook handler.

> These are **sandbox** objects (the token is `POLAR_SANDBOX_ACCESS_TOKEN`).
> Production products/webhook + token swap are a deploy-time concern.

## Steps

1. ```sh
   node .skills/12-payments/setup.mjs
   ```
2. ```sh
   node .skills/12-payments/verify.mjs
   ```
   Confirms both products exist with the right one-time amounts, the webhook
   endpoint is registered for `order.paid` at the right URL, the env vars are
   persisted, and a **live checkout session** can be created for the Base
   product (proving the product is purchasable).
3. Stage candidate, then **in-line council** + **collab review**
   (`node .skills/_collab-review/run.mjs 12-payments`). Both must approve.

## Output

- Polar sandbox products (Base $19, Premium $39) + webhook endpoint.
- `.env`: `POLAR_PRODUCT_BASE_ID`, `POLAR_PRODUCT_PREMIUM_ID`,
  `POLAR_WEBHOOK_SECRET`, `POLAR_WEBHOOK_ENDPOINT_ID`.
- ralph requirements: `polar-checkout-flow`, `polar-webhook-handler`.
- `.supertools-state/12-payments.json` — receipt.

## Idempotency

Re-runnable. Products matched by name and reused. Webhook reused when the
secret is already persisted; otherwise recreated to recover a usable secret.

## Common failure modes

| Symptom | Fix |
|---|---|
| `organization_id is disallowed` | Don't pass `organization_id` — the token is org-scoped (the helper already omits it). |
| Webhook secret missing on reuse | Expected once — setup recreates the endpoint to mint a fresh secret and persists it. |
| Checkout create fails | Confirm the product has an active fixed price; re-run setup to repair. |
