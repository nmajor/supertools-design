#!/usr/bin/env node
// 05-domain-dns setup.
// CAA records (full CF Universal SSL CA set) + records naked→www as a Worker
// requirement for the ralph plan. Idempotent.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { cf, findZoneId, listDnsRecords } from '../_shared/cf.mjs';
import { appendRalphRequirement } from '../_shared/state.mjs';
import { DESIRED_CAA, CAA_VALUES, normalizeCaaValue } from './caa-set.mjs';

const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '05-domain-dns');

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

async function readProjectDomain() {
  const p = path.join(PROJECT_ROOT, '.supertools-state', 'project.json');
  const j = JSON.parse(await fs.readFile(p, 'utf-8'));
  if (!j.domain) die('project.json has no "domain" — run skill 00 first.');
  return j.domain;
}

async function ensureCaaRecord(zoneId, domain, existing, tag, value) {
  const match = existing.find(
    (r) => r.data?.tag === tag && normalizeCaaValue(r.data?.value) === normalizeCaaValue(value)
  );
  if (match) {
    log(`  skip CAA ${tag} "${value}" (present)`);
    return { action: 'skipped', tag, value };
  }
  // CAA allows multiple issuers per tag, so a differing value isn't a
  // conflict — just add the missing one.
  const r = await cf(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'CAA',
      name: domain,
      data: { flags: 0, tag, value },
      ttl: 1,
    }),
  });
  if (!r.ok) die(`CF create CAA ${tag} "${value}" failed: ${JSON.stringify(r.body.errors || r.body)}`);
  log(`  created CAA ${tag} "${value}"`);
  return { action: 'created', tag, value };
}

async function snapshotZone(zoneId, label) {
  const dns = await listDnsRecords(zoneId, {});
  return {
    label,
    dnsRecords: dns.map((r) => ({ type: r.type, name: r.name, content: r.content, data: r.data })),
  };
}

async function main() {
  loadEnv();
  requireEnv(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
  await fs.mkdir(STATE_SUB, { recursive: true });

  const domain = await readProjectDomain();
  log(`▶ Resolving CF zone for ${domain}...`);
  const zoneId = await findZoneId(domain);
  log(`  zone ${zoneId}`);

  const before = await snapshotZone(zoneId, 'before');

  log(`▶ Ensuring ${DESIRED_CAA.length} CAA records (CF Universal SSL CAs, issue + issuewild)...`);
  const existingCaa = await listDnsRecords(zoneId, { name: domain, type: 'CAA' });
  const caaActions = [];
  for (const { tag, value } of DESIRED_CAA) {
    caaActions.push(await ensureCaaRecord(zoneId, domain, existingCaa, tag, value));
  }

  // naked → www is handled by the Worker (per project decision), not a CF
  // redirect rule — the CF token has DNS edit but not Dynamic-Redirect edit,
  // and a worker-level 301 is more reproducible (no extra token scope, any
  // CF plan). Record it as a requirement skill 14 folds into the ralph plan.
  log('▶ Recording naked → www as a Worker requirement for the ralph plan...');
  const ralphReq = await appendRalphRequirement(
    '05-domain-dns',
    'naked-to-www-redirect',
    `The Worker must 301-redirect the naked apex host "${domain}" to ` +
    `"https://www.${domain}" preserving path + query string. Apply before ` +
    `any auth/session logic so it covers every route.`
  );
  log(`  recorded: ${ralphReq.key}`);

  // Spec-site preview wildcard is likewise Worker-dependent (proxied wildcard
  // record + Worker route + header injection), so it is deferred to the
  // serving/deploy work and recorded as a requirement here (spec.md §4).
  log('▶ Recording spec-site preview wildcard as a Worker requirement...');
  const wildcardReq = await appendRalphRequirement(
    '05-domain-dns',
    'preview-wildcard-serving',
    `Spec/preview sites serve at {slug}.${domain}: create a proxied wildcard ` +
    `DNS record (*.${domain}) + Worker route when the router Worker exists. ` +
    `Every preview-hostname response MUST carry "X-Robots-Tag: noindex, nofollow" ` +
    `set at the router (header-level, never trusting generated HTML), and the ` +
    `preview zone robots.txt must disallow all (spec.md §4 hidden-spec-site posture).`
  );
  log(`  recorded: ${wildcardReq.key}`);

  const after = await snapshotZone(zoneId, 'after');
  await fs.writeFile(
    path.join(STATE_SUB, 'zone-snapshot.json'),
    JSON.stringify({ zoneId, domain, before, after }, null, 2) + '\n'
  );

  const summary = {
    domain,
    zoneId,
    caa: {
      cas: CAA_VALUES,
      desiredRecords: DESIRED_CAA.length,
      created: caaActions.filter((a) => a.action === 'created').length,
      skipped: caaActions.filter((a) => a.action === 'skipped').length,
    },
    nakedToWww: { handledBy: 'worker', deferredToRalph: true, requirementKey: ralphReq.key },
    previewWildcard: { handledBy: 'worker', deferredToRalph: true, requirementKey: wildcardReq.key },
    completedAt: new Date().toISOString(),
  };
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
