#!/usr/bin/env node
// 12-payments setup.
// Polar (sandbox) one-time products + order webhook endpoint. Idempotent.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, requireEnv, writeEnvVar, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';

const BRAND = readProject().brandName;
import { polar, listAll } from '../_shared/polar.mjs';
import { appendRalphRequirement } from '../_shared/state.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '12-payments');
const PRODUCTS = [
  { name: `${BRAND} Base`, amount: 1900, idKey: 'POLAR_PRODUCT_BASE_ID' },
  { name: `${BRAND} Premium`, amount: 3900, idKey: 'POLAR_PRODUCT_PREMIUM_ID' },
];

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

async function readDomain() {
  const j = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8'));
  if (!j.domain) die('project.json has no "domain"');
  return j.domain;
}

async function ensureProduct(name, amount) {
  const existing = (await listAll('/products')).find((p) => p.name === name);
  if (existing) {
    log(`[polar] product "${name}" exists (${existing.id})`);
    return existing;
  }
  log(`[polar] creating product "${name}" ($${(amount / 100).toFixed(0)} one-time)...`);
  const r = await polar('/products', {
    method: 'POST',
    body: JSON.stringify({
      name,
      recurring_interval: null,
      prices: [{ amount_type: 'fixed', price_amount: amount, price_currency: 'usd' }],
    }),
  });
  if (!r.ok) die(`Polar create product "${name}" failed (${r.status}): ${JSON.stringify(r.body).slice(0, 240)}`);
  return r.body;
}

async function ensureWebhook(domain) {
  const url = `https://${domain}/api/polar/webhook`;
  const events = ['order.paid', 'checkout.updated'];
  const existing = (await listAll('/webhooks/endpoints')).find((w) => w.url === url);

  // Reuse only if we already hold the secret (it's returned only at creation).
  if (existing && process.env.POLAR_WEBHOOK_SECRET && process.env.POLAR_WEBHOOK_ENDPOINT_ID === existing.id) {
    log(`[polar] reusing webhook endpoint ${existing.id}`);
    return { id: existing.id, secret: process.env.POLAR_WEBHOOK_SECRET, recreated: false };
  }
  if (existing) {
    log(`[polar] webhook endpoint exists but secret not persisted — recreating to mint a fresh secret`);
    await polar(`/webhooks/endpoints/${existing.id}`, { method: 'DELETE' });
  }
  const r = await polar('/webhooks/endpoints', {
    method: 'POST',
    body: JSON.stringify({ url, format: 'raw', events }),
  });
  if (!r.ok || !r.body.secret) die(`Polar create webhook failed (${r.status}): ${JSON.stringify(r.body).slice(0, 240)}`);
  log(`[polar] created webhook endpoint ${r.body.id}`);
  return { id: r.body.id, secret: r.body.secret, recreated: Boolean(existing) };
}

async function main() {
  loadEnv();
  requireEnv(['POLAR_SANDBOX_ACCESS_TOKEN']);
  await fs.mkdir(STATE_SUB, { recursive: true });
  const domain = await readDomain();

  const products = [];
  for (const def of PRODUCTS) {
    const p = await ensureProduct(def.name, def.amount);
    const price = (p.prices || []).find((x) => x.amount_type === 'fixed');
    if (!price || price.price_amount !== def.amount) {
      die(`Product "${def.name}" price mismatch: expected ${def.amount}, got ${price?.price_amount}`);
    }
    await writeEnvVar(def.idKey, p.id);
    products.push({ name: def.name, id: p.id, amount: def.amount, priceId: price.id, idKey: def.idKey });
  }

  const webhook = await ensureWebhook(domain);
  await writeEnvVar('POLAR_WEBHOOK_SECRET', webhook.secret);
  await writeEnvVar('POLAR_WEBHOOK_ENDPOINT_ID', webhook.id);

  await appendRalphRequirement('12-payments', 'polar-checkout-flow',
    `Paid-unlock checkout: when the buyer unlocks a direction, create a Polar checkout session ` +
    `(POST /v1/checkouts with products:[POLAR_PRODUCT_BASE_ID] or [..PREMIUM_ID]) and redirect to its url. ` +
    `On success_url, mark the Order paid and start the pack render. Use the sandbox token in dev; ` +
    `production swaps to a prod Polar token + prod product ids at deploy.`);
  await appendRalphRequirement('12-payments', 'polar-webhook-handler',
    `Implement POST /api/polar/webhook: verify the signature with POLAR_WEBHOOK_SECRET (Polar uses the ` +
    `standard-webhooks spec; @polar-sh/sdk exposes validateEvent). On order.paid, mark the matching Order ` +
    `paid and trigger pack generation; ignore unrecognized events; always return 2xx fast. The endpoint is ` +
    `already registered at https://${domain}/api/polar/webhook.`);

  const summary = {
    domain,
    products,
    webhook: { id: webhook.id, url: `https://${domain}/api/polar/webhook`, events: ['order.paid', 'checkout.updated'], recreated: webhook.recreated },
    envWritten: [...PRODUCTS.map((p) => p.idKey), 'POLAR_WEBHOOK_SECRET', 'POLAR_WEBHOOK_ENDPOINT_ID'],
    environment: 'sandbox',
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(STATE_SUB, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
