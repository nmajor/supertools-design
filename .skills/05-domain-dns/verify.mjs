#!/usr/bin/env node
// 05-domain-dns verifier.
// Confirms the full CAA set is present and naked→www was recorded as a
// Worker requirement for the ralph plan.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { findZoneId, listDnsRecords } from '../_shared/cf.mjs';
import { DESIRED_CAA, normalizeCaaValue } from './caa-set.mjs';
import { buildRedactor } from '../_shared/redact.mjs';

// Redaction by construction (authoring-checklist #5) — CAA values and zone
// ids are public DNS, but the sweep keeps every verifier uniform.
let redact = (s) => s;
const checks = [];
const fail = (n, d = '') => { checks.push({ name: redact(n), ok: false, detail: redact(d) }); };
const pass = (n, d = '') => { checks.push({ name: redact(n), ok: true, detail: redact(d) }); };

async function main() {
  loadEnv();
  redact = buildRedactor([]).redact;
  requireEnv(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);

  const project = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8')
  );
  const domain = project.domain;

  let zoneId;
  try { zoneId = await findZoneId(domain); pass('zone resolved', zoneId); }
  catch (e) { fail('zone resolved', e.message); return report(); }

  // CAA records — check the full documented set from the shared module.
  const caa = await listDnsRecords(zoneId, { name: domain, type: 'CAA' });
  for (const { tag, value } of DESIRED_CAA) {
    const found = caa.find(
      (r) => r.data?.tag === tag && normalizeCaaValue(r.data?.value) === normalizeCaaValue(value)
    );
    found
      ? pass(`CAA ${tag} "${value}"`)
      : fail(`CAA ${tag} "${value}"`, 'missing');
  }

  // naked→www is a Worker requirement, not a CF rule — confirm it was
  // recorded for the ralph plan rather than checking for a redirect rule.
  try {
    const reqs = JSON.parse(
      await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'ralph-requirements.json'), 'utf-8')
    );
    reqs.some((r) => r.skillId === '05-domain-dns' && r.key === 'naked-to-www-redirect')
      ? pass('naked→www recorded as ralph requirement')
      : fail('naked→www recorded as ralph requirement', 'not found in ralph-requirements.json');
    reqs.some((r) => r.skillId === '05-domain-dns' && r.key === 'preview-wildcard-serving')
      ? pass('preview wildcard recorded as ralph requirement')
      : fail('preview wildcard recorded as ralph requirement', 'not found in ralph-requirements.json');
  } catch (e) {
    fail('naked→www + preview-wildcard requirements', `ralph-requirements.json unreadable: ${e.message}`);
  }

  report();
}

function report() {
  let ok = 0;
  for (const c of checks) {
    console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    if (c.ok) ok++;
  }
  console.log(`\n${ok}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
