#!/usr/bin/env node
// 12-payments verifier.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';
import { polar, listAll } from '../_shared/polar.mjs';

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };

async function main() {
  loadEnv();
  requireEnv(['POLAR_SANDBOX_ACCESS_TOKEN', 'POLAR_PRODUCT_BASE_ID', 'POLAR_PRODUCT_PREMIUM_ID', 'POLAR_WEBHOOK_SECRET', 'POLAR_WEBHOOK_ENDPOINT_ID']);
  const project = readProject();
  const domain = project.domain;
  const brand = project.brandName;

  // products exist with correct one-time amounts, matching persisted ids
  const wants = [
    { name: `${brand} Base`, amount: 1900, env: process.env.POLAR_PRODUCT_BASE_ID },
    { name: `${brand} Premium`, amount: 3900, env: process.env.POLAR_PRODUCT_PREMIUM_ID },
  ];
  for (const w of wants) {
    const r = await polar(`/products/${w.env}`);
    if (!r.ok) { fail(`product ${w.name}`, `id ${w.env} not found (${r.status})`); continue; }
    const price = (r.body.prices || []).find((p) => p.amount_type === 'fixed');
    const oneTime = r.body.recurring_interval === null || r.body.recurring_interval === undefined;
    r.body.name === w.name && price?.price_amount === w.amount && oneTime
      ? pass(`product ${w.name}`, `$${(w.amount / 100).toFixed(0)} one-time, id ${w.env.slice(0, 8)}…`)
      : fail(`product ${w.name}`, `name=${r.body.name} amount=${price?.price_amount} recurring=${r.body.recurring_interval}`);
  }

  // webhook endpoint registered at the right url + order.paid, matching persisted id
  const endpoints = await listAll('/webhooks/endpoints');
  const wantUrl = `https://${domain}/api/polar/webhook`;
  const wh = endpoints.find((w) => w.id === process.env.POLAR_WEBHOOK_ENDPOINT_ID);
  if (!wh) {
    fail('webhook endpoint', `persisted id ${process.env.POLAR_WEBHOOK_ENDPOINT_ID} not found on account`);
  } else {
    wh.url === wantUrl ? pass('webhook url', wh.url) : fail('webhook url', `got ${wh.url}, want ${wantUrl}`);
    (wh.events || []).includes('order.paid') ? pass('webhook subscribes order.paid') : fail('webhook subscribes order.paid', (wh.events || []).join(','));
  }

  // env persistence
  let env = '';
  try { env = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf-8'); } catch {}
  for (const k of ['POLAR_PRODUCT_BASE_ID', 'POLAR_PRODUCT_PREMIUM_ID', 'POLAR_WEBHOOK_SECRET', 'POLAR_WEBHOOK_ENDPOINT_ID']) {
    new RegExp(`^${k}=.+$`, 'm').test(env) ? pass(`${k} in .env`) : fail(`${k} in .env`, 'missing');
  }
  /^POLAR_WEBHOOK_SECRET=polar_wh/m.test(env) ? pass('webhook secret looks valid (polar_wh…)') : fail('webhook secret looks valid', 'not a polar_wh secret');

  // live checkout session can be created for Base (proves purchasability)
  const co = await polar('/checkouts/', { method: 'POST', body: JSON.stringify({ products: [process.env.POLAR_PRODUCT_BASE_ID] }) });
  co.ok && co.body.url && co.body.amount === 1900
    ? pass('live checkout session (Base)', `status ${co.body.status}, $${(co.body.amount / 100).toFixed(0)}`)
    : fail('live checkout session (Base)', `${co.status} ${JSON.stringify(co.body).slice(0, 160)}`);

  let okC = 0;
  for (const c of checks) { console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`); if (c.ok) okC++; }
  console.log(`\n${okC}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
