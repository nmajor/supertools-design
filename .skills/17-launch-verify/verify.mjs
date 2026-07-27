#!/usr/bin/env node
// 17-launch-verify verifier — re-assert the hard live checks + confirm the
// launch report shows every hard check (and the real generation) passed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from '../_shared/env.mjs';
import { requireDomain } from '../_shared/project.mjs';

const DOMAIN = requireDomain();
const WWW = `https://www.${DOMAIN}`;
// Path used to prove the apex->www 301 preserves path+query. Override per project.
const PROBE_PATH = process.env.LAUNCH_PROBE_PATH || '/';
const checks = [];
const pass = (n, d = '') => checks.push({ n, ok: true, d });
const fail = (n, d = '') => checks.push({ n, ok: false, d });

async function main() {
  // re-check the load-bearing live endpoints
  try { const r = await fetch(`${WWW}/`); r.ok ? pass('live home 200', `HTTP ${r.status}`) : fail('live home 200', `HTTP ${r.status}`); } catch (e) { fail('live home 200', e.message); }
  try { const r = await fetch(`${WWW}/api/health`); const j = await r.json().catch(() => ({})); (r.ok && j.ok === true) ? pass('live /api/health', `HTTP ${r.status}`) : fail('live /api/health', `HTTP ${r.status}`); } catch (e) { fail('live /api/health', e.message); }
  try { const r = await fetch(`https://${DOMAIN}${PROBE_PATH}?x=1`, { redirect: 'manual' }); const loc = r.headers.get('location') || ''; ([301, 308].includes(r.status) && loc === `${WWW}${PROBE_PATH}?x=1`) ? pass('apex→www 301 preserves path+query', `${r.status}`) : fail('apex→www 301 preserves path+query', `${r.status} → ${loc}`); } catch (e) { fail('apex→www', e.message); }

  // the report exists and every HARD check (incl. real generation) passed
  const rep = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', '17-launch-verify', 'report.json'), 'utf-8').catch(() => 'null'));
  if (!rep) { fail('launch report present', 'missing'); }
  else {
    pass('launch report present', `${rep.hardPassed}/${rep.hardTotal} hard, ${rep.verifiedPassed}/${rep.verifiedTotal} verified`);
    (rep.hardPassed === rep.hardTotal && rep.hardTotal > 0) ? pass('all hard launch checks passed') : fail('all hard launch checks passed', `${rep.hardPassed}/${rep.hardTotal}`);
    (rep.verifiedPassed === rep.verifiedTotal && rep.verifiedTotal > 0) ? pass('all verified launch checks passed') : fail('all verified launch checks passed', `${rep.verifiedPassed}/${rep.verifiedTotal}`);
    (typeof rep.directionsCount === 'number' && rep.directionsCount >= 3) ? pass('≥3 directions generated live', `${rep.directionsCount}`) : fail('≥3 directions generated live', `${rep.directionsCount}`);
    const gen = (rep.checks || []).find((c) => /REAL directions generation/.test(c.name));
    (gen && gen.ok) ? pass('real generation verified live', gen.detail) : fail('real generation verified live', gen ? gen.detail : 'check missing');
  }

  let ok = 0;
  for (const c of checks) { console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.n}${c.d ? ' — ' + c.d : ''}`); if (c.ok) ok++; }
  console.log(`\n${ok}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
