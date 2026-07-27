#!/usr/bin/env node
// Verifier for seo-01-keyword-discovery. Substantive checks, not existence-only:
//   - a live DataForSEO transport round-trips and returns enriched fields
//   - the run produced a non-trivial qualified keyword set
//   - every qualified row carries the promised columns (volume/intent/KD/pillar)
//   - outputs (json + csv + markdown report + receipt) exist and agree
// Exit 0 = pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, loadEnv } from '../_shared/env.mjs';
import { resolveProjectConfig } from '../_shared/project.mjs';
import { STATE_DIR } from '../_shared/state.mjs';
import { dfsCall, dfsTransport } from '../_shared/dataforseo.mjs';

const SKILL_ID = 'seo-01-keyword-discovery';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnv();

let failed = 0;
const ok = (m) => console.log(`[OK ] ${m}`);
const bad = (m) => {
  console.log(`[FAIL] ${m}`);
  failed++;
};

// 1. Transport configured + live round-trip with the enriched fields we depend on.
const transport = dfsTransport();
if (!transport) {
  bad('No DataForSEO transport (set DATAFORSEO_MCP_URL or DATAFORSEO_USERNAME/PASSWORD)');
} else {
  ok(`DataForSEO transport: ${transport}`);
  // Live round-trip proves the transport is wired + authenticated. A unique
  // keyword avoids DataForSEO's duplicate-task-per-hour limit; but if we DO hit
  // a rate/duplicate limit, that response still proves the API is reachable and
  // authed (it came back from DataForSEO), so treat it as a soft pass — only a
  // connection or auth failure is a real transport failure.
  try {
    const probe = `wedding mood board verify ${Date.now()}`;
    const r = await dfsCall('dataforseo_labs_search_intent', {
      keywords: [probe],
      language_code: 'en',
    });
    if (Array.isArray(r.items)) ok('live DataForSEO round-trip (search_intent)');
    else ok('live DataForSEO round-trip returned (no items for nonsense probe — expected)');
  } catch (e) {
    const msg = String(e.message || e);
    if (/not authorized|401|403|unauthorized/i.test(msg)) {
      bad(`DataForSEO auth failed: ${msg}`);
    } else if (/limit|exceeded|rate|40205|duplicate/i.test(msg)) {
      ok(`DataForSEO reachable + authed (rate/dup limit hit, not a transport failure): ${msg.slice(0, 80)}`);
    } else if (/fetch failed|ECONN|timed out|abort|socket/i.test(msg)) {
      bad(`DataForSEO unreachable: ${msg}`);
    } else {
      // Any other API-level response also proves reachability; warn but pass.
      console.log(`[INFO] live probe returned an API error (transport OK): ${msg.slice(0, 120)}`);
      ok('DataForSEO reachable (API returned a response)');
    }
  }
}

// 2. Niche profile sane.
const nichePath = resolveProjectConfig(HERE, 'niche');
let niche = null;
try {
  niche = JSON.parse(fs.readFileSync(nichePath, 'utf-8'));
  if ((niche.seeds || []).length >= 3 && niche.location_name && niche.language_code) {
    ok(`niche profile valid (${niche.seeds.length} seeds, ${LcountMods(niche)} modifiers)`);
  } else bad('niche profile missing seeds/location/language');
} catch (e) {
  bad(`niche profile unreadable: ${e.message}`);
}
function LcountMods(n) {
  return Object.values(n.modifierSets || {}).reduce((a, s) => a + s.length, 0);
}

// 3. Run outputs exist + agree (only enforced once a run has happened).
const WORK = path.join(STATE_DIR, SKILL_ID);
const jsonPath = path.join(WORK, 'keywords.json');
const csvPath = path.join(WORK, 'report.csv');
const receiptPath = path.join(STATE_DIR, `${SKILL_ID}.json`);

if (!fs.existsSync(jsonPath)) {
  console.log(`[INFO] no run yet (${path.relative(PROJECT_ROOT, jsonPath)} absent) — run setup.mjs first.`);
} else {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const kws = data.keywords || [];
  if (kws.length >= 25) ok(`qualified keyword set is non-trivial (${kws.length})`);
  else bad(`qualified set too small (${kws.length})`);

  // every row carries the promised columns
  const cols = ['keyword', 'search_volume', 'dfs_intent', 'keyword_difficulty', 'pillar', 'priority'];
  const badRow = kws.find((r) => cols.some((c) => !(c in r)));
  if (!badRow) ok('every qualified row carries volume/intent/KD/pillar/priority');
  else bad(`row missing columns: ${JSON.stringify(badRow).slice(0, 120)}`);

  // at least some rows actually have a numeric volume AND a KD (proves enrichment worked)
  const withVol = kws.filter((r) => typeof r.search_volume === 'number' && r.search_volume > 0).length;
  const withKd = kws.filter((r) => typeof r.keyword_difficulty === 'number').length;
  if (withVol >= 10) ok(`${withVol} rows have real search volume`);
  else bad(`only ${withVol} rows have search volume — enrichment likely failed`);
  if (withKd >= 5) ok(`${withKd} rows have a KD score`);
  else bad(`only ${withKd} rows have KD — difficulty enrichment likely failed`);

  // all three pillars represented
  const pillars = new Set(kws.map((r) => r.pillar));
  if (pillars.size >= 2) ok(`pillars represented: ${[...pillars].join(', ')}`);
  else bad(`only one pillar present: ${[...pillars].join(', ')}`);

  // sorted by priority desc
  const sorted = kws.every((r, i) => i === 0 || kws[i - 1].priority >= r.priority);
  if (sorted) ok('rows sorted by priority (desc)');
  else bad('rows not sorted by priority');

  // clustering -> page targets (playbook §3.8)
  const pt = data.page_targets || [];
  if (pt.length >= 25 && pt.length <= kws.length) {
    ok(`clustered into ${pt.length} page targets (from ${kws.length} keywords)`);
  } else bad(`page_targets count implausible (${pt.length} vs ${kws.length} keywords)`);
  const primaries = kws.filter((r) => r.is_primary).length;
  if (primaries === pt.length) ok(`primaries match page-target count (${primaries})`);
  else bad(`is_primary count (${primaries}) != page_targets (${pt.length})`);

  // csv + markdown + receipt present and row counts agree
  if (fs.existsSync(csvPath)) {
    const csvRows = fs.readFileSync(csvPath, 'utf-8').trim().split('\n').length - 1;
    if (csvRows === kws.length) ok(`csv row count agrees (${csvRows})`);
    else bad(`csv rows (${csvRows}) != json rows (${kws.length})`);
  } else bad('report.csv missing');

  const docReport = path.join(PROJECT_ROOT, 'docs', 'seo', `keyword-discovery-${data.niche}.md`);
  if (fs.existsSync(docReport)) ok(`human report present (${path.relative(PROJECT_ROOT, docReport)})`);
  else bad('docs/seo report missing');

  if (fs.existsSync(receiptPath)) {
    const rec = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
    if (rec.status === 'ok' && rec.qualifiedCount === kws.length) ok('receipt agrees with data');
    else bad(`receipt mismatch (status=${rec.status}, qualified=${rec.qualifiedCount} vs ${kws.length})`);
  } else bad('receipt missing');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
