#!/usr/bin/env node
// seo-01-keyword-discovery — discover bottom-of-funnel keyword targets for a
// niche, enriched with search volume + search intent + keyword difficulty.
//
// Implements the Compact Keywords playbook discovery process
// (docs/compact-keywords-guide.md §3) against DataForSEO:
//
//   1. Brainstorm   -> seeds + competitors + JTDB from the niche profile
//   2. Modifier stack -> synthetic candidates (patterns x modifier sets, §3.3)
//   3. SERP harvest -> People Also Ask + Related Searches (§3.1 step 2)
//   4. Tool augment -> keyword_suggestions + keyword_ideas expansion (§3.1 step 3)
//   5. Enrich       -> volume + KD + intent via keyword_overview
//   6. Classify     -> Category / Comparison / JTBD pillar + commercial fit (§2)
//   7. Score & rank -> composite priority (§4.1), then write the report
//
// Idempotent + cheap to re-run: every DataForSEO call is cached on disk by
// (tool, args) hash, so re-runs reuse results and don't re-bill.
//
// Usage:
//   node .skills/seo-01-keyword-discovery/setup.mjs [niche.json] [--no-cache]

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, loadEnv } from '../_shared/env.mjs';
import { resolveProjectConfig } from '../_shared/project.mjs';
import { STATE_DIR, writeReceipt } from '../_shared/state.mjs';
import { dfsCall, dfsTransport, assertDfsCredentials } from '../_shared/dataforseo.mjs';

const SKILL_ID = 'seo-01-keyword-discovery';
const HERE = path.dirname(fileURLToPath(import.meta.url));

loadEnv(); // pulls .env; MCP url + DFS user/pass may already be in process.env
assertDfsCredentials();

// ---------- args ----------
const args = process.argv.slice(2);
const noCache = args.includes('--no-cache');
const nicheArg = args.find((a) => !a.startsWith('--'));
const nichePath = nicheArg
  ? path.resolve(process.cwd(), nicheArg)
  : resolveProjectConfig(HERE, 'niche');
if (!fs.existsSync(nichePath)) {
  console.error(`Niche profile not found: ${nichePath}`);
  process.exit(1);
}
const niche = JSON.parse(fs.readFileSync(nichePath, 'utf-8'));
const LOCATION = niche.location_name || 'United States';
const LANGUAGE = niche.language_code || 'en';
const L = niche.limits || {};
const suggestionLimit = L.suggestionLimit ?? 150;
const ideaLimit = L.ideaLimit ?? 120;
const maxCandidates = L.maxCandidates ?? 1400;
const overviewBatch = Math.min(L.overviewBatch ?? 700, 700);

// ---------- workdir + cache ----------
const WORK = path.join(STATE_DIR, SKILL_ID);
const CACHE = path.join(WORK, 'cache');
await fsp.mkdir(CACHE, { recursive: true });

let apiCalls = 0;
let cacheHits = 0;
async function cachedCall(tool, callArgs) {
  const key = crypto
    .createHash('sha1')
    .update(JSON.stringify({ tool, callArgs }))
    .digest('hex')
    .slice(0, 16);
  const file = path.join(CACHE, `${tool}.${key}.json`);
  if (!noCache && fs.existsSync(file)) {
    cacheHits++;
    return JSON.parse(await fsp.readFile(file, 'utf-8'));
  }
  const result = await dfsCall(tool, callArgs);
  apiCalls++;
  await fsp.writeFile(file, JSON.stringify(result));
  return result;
}

// ---------- helpers ----------
const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
const log = (...a) => console.log('[kw]', ...a);

// candidate pool: normalized keyword -> { keyword, sources:Set }
const pool = new Map();
function add(keyword, source) {
  const k = norm(keyword);
  if (!k || k.length < 3) return;
  if (!pool.has(k)) pool.set(k, { keyword: k, sources: new Set() });
  pool.get(k).sources.add(source);
}

// ===== 1. Brainstorm: seeds, competitors, JTBD =====
for (const s of niche.seeds || []) add(s, 'seed');
for (const c of niche.competitors || []) add(c, 'competitor');
for (const j of niche.jtbd || []) add(j, 'jtbd');

// ===== 2. Modifier-stacked synthetic candidates =====
let synthCount = 0;
for (const p of niche.patterns || []) {
  const set = niche.modifierSets?.[p.modifiers] || [];
  for (const m of set) {
    add(p.template.replace('{m}', m), 'synthetic');
    synthCount++;
  }
}
log(`brainstorm+synthetic: ${pool.size} candidates (${synthCount} synthetic combos)`);

// ===== 3. SERP harvest: People Also Ask + Related Searches =====
let serpAdded = 0;
for (const seed of niche.serpSeeds || []) {
  try {
    const r = await cachedCall('serp_organic_live_advanced', {
      keyword: seed,
      location_name: LOCATION,
      language_code: LANGUAGE,
      depth: 10,
    });
    for (const it of r.items || []) {
      if (it.type === 'related_searches') {
        for (const rs of it.items || []) {
          add(typeof rs === 'string' ? rs : rs?.title || rs?.keyword, 'serp_related');
          serpAdded++;
        }
      }
      if (it.type === 'people_also_ask') {
        for (const paa of it.items || []) {
          add(paa?.title, 'serp_paa');
          serpAdded++;
        }
      }
    }
  } catch (e) {
    log(`serp harvest failed for "${seed}": ${e.message}`);
  }
}
log(`serp harvest: +${serpAdded} candidates (pool ${pool.size})`);

// ===== 4. Tool augmentation: suggestions + ideas expansion =====
// These return keyword_info.search_volume; we keep it as a hint for trimming
// the pool before the (uniform) enrichment pass.
const volHint = new Map();
let expandAdded = 0;
for (const seed of niche.expandSeeds || niche.seeds || []) {
  // keyword_suggestions: long-tail variants that CONTAIN the seed
  try {
    const r = await cachedCall('dataforseo_labs_google_keyword_suggestions', {
      keyword: seed,
      location_name: LOCATION,
      language_code: LANGUAGE,
      limit: suggestionLimit,
    });
    for (const it of r.items || []) {
      add(it.keyword, 'suggestion');
      expandAdded++;
      const v = it.keyword_info?.search_volume;
      if (v != null) volHint.set(norm(it.keyword), v);
    }
  } catch (e) {
    log(`suggestions failed for "${seed}": ${e.message}`);
  }
  // keyword_ideas: broader same-category ideas (not necessarily containing seed)
  try {
    const r = await cachedCall('dataforseo_labs_google_keyword_ideas', {
      keywords: [seed],
      location_name: LOCATION,
      language_code: LANGUAGE,
      limit: ideaLimit,
    });
    for (const it of r.items || []) {
      add(it.keyword, 'idea');
      expandAdded++;
      const v = it.keyword_info?.search_volume;
      if (v != null) volHint.set(norm(it.keyword), v);
    }
  } catch (e) {
    log(`ideas failed for "${seed}": ${e.message}`);
  }
}
log(`expansion: +${expandAdded} raw (pool ${pool.size})`);

// ===== Trim pool to maxCandidates before enrichment (cost control) =====
// Keep ALL high-fit sources (seed/synthetic/competitor/jtbd/serp); fill the
// remainder with the highest-volume expansion candidates.
const PRIORITY_SOURCES = new Set([
  'seed', 'synthetic', 'competitor', 'jtbd', 'serp_related', 'serp_paa',
]);
let candidates = [...pool.values()];
const priority = candidates.filter((c) => [...c.sources].some((s) => PRIORITY_SOURCES.has(s)));
const rest = candidates
  .filter((c) => ![...c.sources].some((s) => PRIORITY_SOURCES.has(s)))
  .sort((a, b) => (volHint.get(b.keyword) || 0) - (volHint.get(a.keyword) || 0));
candidates = [...priority, ...rest].slice(0, maxCandidates);
log(`enriching ${candidates.length} candidates (trimmed from ${pool.size})`);

// ===== 5. Enrich: volume + KD + intent via keyword_overview =====
const enriched = new Map(); // keyword -> record
for (let i = 0; i < candidates.length; i += overviewBatch) {
  const batch = candidates.slice(i, i + overviewBatch).map((c) => c.keyword);
  const r = await cachedCall('dataforseo_labs_google_keyword_overview', {
    keywords: batch,
    location_name: LOCATION,
    language_code: LANGUAGE,
  });
  for (const it of r.items || []) {
    const ki = it.keyword_info || {};
    enriched.set(norm(it.keyword), {
      keyword: it.keyword,
      search_volume: ki.search_volume ?? null,
      cpc: ki.cpc ?? null,
      competition: ki.competition ?? null,
      competition_level: ki.competition_level ?? null,
      keyword_difficulty: it.keyword_properties?.keyword_difficulty ?? null,
      // core_keyword is DataForSEO's own clustering signal — keywords that
      // share a core map to one page target (playbook §3.8).
      core_keyword: it.keyword_properties?.core_keyword || norm(it.keyword),
      dfs_intent: it.search_intent_info?.main_intent ?? null,
      trend_yearly: ki.search_volume_trend?.yearly ?? null,
    });
  }
  log(`enriched batch ${Math.floor(i / overviewBatch) + 1} (${enriched.size} total)`);
}

// ===== 6 + 7. Classify, score, rank =====
const RX = {
  comparison: /\b(vs|versus|alternative|alternatives|competitor|compare|or)\b/,
  tool: /\b(maker|generator|creator|builder|template|templates|app|tool|online|create|design|free|software|website)\b/,
  jtbdQuestion: /^(how|what|where|which|why|do i|whats|what's)\b/,
  jtbdPhrase: /\b(how to|what is my|find your|choose|pick)\b/,
  productFit: /(mood ?board|vision board|colou?r palette|colou?r scheme|wedding colou?rs|aesthetic|style quiz|wedding style|wedding theme|inspo|inspiration board|palette generator|vibe quiz)/,
};

function classify(kw) {
  const k = kw;
  if (RX.comparison.test(k)) return 'comparison';
  if (RX.jtbdQuestion.test(k) || RX.jtbdPhrase.test(k)) return 'jtbd';
  if (RX.tool.test(k)) return 'category';
  return 'category'; // descriptive aesthetic noun-phrases default to category
}

// sub-scores (each ~0..5)
function intentScore(rec, pillar, fit) {
  const m = { transactional: 5, commercial: 4, navigational: 3, informational: 2 };
  let s = m[rec.dfs_intent] ?? 2;
  // For a generator product, JTBD/how-to is genuine BOFU even when DFS says
  // "informational"; and exact product-fit phrasing is buy-ready.
  if (pillar === 'jtbd') s = Math.max(s, 3.5);
  if (fit) s = Math.max(s, 4);
  return s;
}
function difficultyScore(kd) {
  if (kd == null) return 3; // unknown -> usually thin long-tail; neutral-good
  if (kd <= 10) return 5;
  if (kd <= 20) return 4;
  if (kd <= 30) return 3;
  if (kd <= 45) return 2;
  return 1;
}
function volumeScore(v) {
  if (!v) return 0;
  if (v >= 1000) return 5;
  if (v >= 500) return 4;
  if (v >= 200) return 3;
  if (v >= 50) return 2;
  return 1;
}
const pillarValue = { comparison: 5, category: 4, jtbd: 3 };

const rows = [];
for (const c of candidates) {
  const rec = enriched.get(c.keyword);
  if (!rec) continue; // no data returned -> skip
  const pillar = classify(c.keyword);
  const fit = RX.productFit.test(c.keyword);
  const sIntent = intentScore(rec, pillar, fit);
  const sDiff = difficultyScore(rec.keyword_difficulty);
  const sVol = volumeScore(rec.search_volume);
  const sPillar = pillarValue[pillar] ?? 2;
  // CPC as a value proxy (playbook §3.4/§4.1, YT-2026): advertisers paying more
  // signal a more valuable click. Capped, small weight.
  const sCpc = Math.min((rec.cpc || 0) / 3, 1); // 0..1
  // Weighted composite -> 0..100. Difficulty + product-fit weighted highest
  // (BOFU thesis: rankability x intent beats raw volume).
  const priorityRaw =
    sIntent * 1.0 + sDiff * 1.3 + sVol * 1.0 + sPillar * 0.7 + (fit ? 4 : 0) + sCpc * 0.5;
  // Max raw = 5*1 + 5*1.3 + 5*1 + 5*0.7 + 4 + 1*0.5 = 24.5. Normalize to 0..100.
  const priority = Math.round((priorityRaw / 24.5) * 1000) / 10;
  rows.push({
    keyword: c.keyword,
    search_volume: rec.search_volume,
    dfs_intent: rec.dfs_intent,
    keyword_difficulty: rec.keyword_difficulty,
    competition_level: rec.competition_level,
    cpc: rec.cpc,
    trend_yearly: rec.trend_yearly,
    pillar,
    product_fit: fit,
    cluster: rec.core_keyword,
    priority,
    sources: [...c.sources].join('|'),
  });
}

// Qualify: must have measurable demand OR be a high-fit product term.
const qualified = rows.filter(
  (r) => (r.search_volume && r.search_volume > 0) || r.product_fit
);
qualified.sort((a, b) => b.priority - a.priority || (b.search_volume || 0) - (a.search_volume || 0));

// ===== Cluster keywords -> page targets (playbook §3.8) =====
// Group by DataForSEO core_keyword. The highest-priority keyword in each
// cluster becomes the primary target (one compact page); the rest are on-page
// variants. Page targets are the real deliverable, not the flat list.
const clusters = new Map(); // cluster -> { primary, variants:[], volume }
for (const r of qualified) {
  // qualified is already priority-sorted, so the first row seen per cluster
  // is the primary.
  if (!clusters.has(r.cluster)) {
    clusters.set(r.cluster, { primary: r, variants: [], clusterVolume: 0 });
    r.is_primary = true;
  } else {
    clusters.get(r.cluster).variants.push(r.keyword);
    r.is_primary = false;
  }
  clusters.get(r.cluster).clusterVolume += r.search_volume || 0;
}
const pageTargets = [...clusters.values()]
  .map((c) => ({
    keyword: c.primary.keyword,
    pillar: c.primary.pillar,
    product_fit: c.primary.product_fit,
    primary_volume: c.primary.search_volume,
    cluster_volume: c.clusterVolume,
    keyword_difficulty: c.primary.keyword_difficulty,
    dfs_intent: c.primary.dfs_intent,
    priority: c.primary.priority,
    variant_count: c.variants.length,
    variants: c.variants.slice(0, 12),
  }))
  .sort((a, b) => b.priority - a.priority || b.cluster_volume - a.cluster_volume);
log(`clustered ${qualified.length} keywords -> ${pageTargets.length} page targets`);

// ===== Write outputs =====
await fsp.mkdir(WORK, { recursive: true });
const jsonOut = {
  schema_version: 'keyword-targets@1', // handoff contract — see docs/seo/seo-pipeline-spec.md §4.1
  niche: niche.niche,
  product: niche.product,
  location_name: LOCATION,
  language_code: LANGUAGE,
  generated_at: new Date().toISOString(),
  transport: dfsTransport(),
  candidate_count: candidates.length,
  enriched_count: enriched.size,
  qualified_count: qualified.length,
  page_target_count: pageTargets.length,
  api_calls: apiCalls,
  cache_hits: cacheHits,
  scoring:
    'priority = (intent*1.0 + difficultyFit*1.3 + volume*1.0 + pillarValue*0.7 + productFit*4 + cpcValue*0.5) normalized to 0-100',
  page_targets: pageTargets,
  keywords: qualified,
};
await fsp.writeFile(path.join(WORK, 'keywords.json'), JSON.stringify(jsonOut, null, 2));

// CSV
const csvHead =
  'keyword,search_volume,intent,keyword_difficulty,competition,cpc,trend_yearly,pillar,product_fit,cluster,is_primary,priority,sources';
const csvLines = qualified.map((r) =>
  [
    `"${r.keyword.replace(/"/g, '""')}"`,
    r.search_volume ?? '',
    r.dfs_intent ?? '',
    r.keyword_difficulty ?? '',
    r.competition_level ?? '',
    r.cpc ?? '',
    r.trend_yearly ?? '',
    r.pillar,
    r.product_fit ? 'yes' : 'no',
    `"${(r.cluster || '').replace(/"/g, '""')}"`,
    r.is_primary ? 'yes' : 'no',
    r.priority,
    r.sources,
  ].join(',')
);
await fsp.writeFile(path.join(WORK, 'report.csv'), [csvHead, ...csvLines].join('\n') + '\n');

// Markdown report -> docs/seo/ for humans
const byPillar = (p) => qualified.filter((r) => r.pillar === p);
const fmtRow = (r) =>
  `| ${r.keyword} | ${r.search_volume ?? '—'} | ${r.dfs_intent ?? '—'} | ${
    r.keyword_difficulty ?? '—'
  } | ${r.competition_level ?? '—'} | ${r.priority} |`;
const tableHead =
  '| Keyword | Vol | Intent | KD | Competition | Priority |\n|---|---|---|---|---|---|';
function section(title, list, n = 25) {
  const top = list.slice(0, n);
  if (!top.length) return `### ${title}\n\n_None found._\n`;
  return `### ${title} (${list.length} total, top ${top.length})\n\n${tableHead}\n${top
    .map(fmtRow)
    .join('\n')}\n`;
}

const md = `# Keyword Discovery — ${niche.niche}

**Generated:** ${jsonOut.generated_at}
**Product:** ${niche.product}
**Market:** ${LOCATION} / ${LANGUAGE}
**Source:** DataForSEO (${dfsTransport()}) — search volume, search intent, keyword difficulty (KD)

Pipeline: brainstorm → modifier-stack → SERP harvest (PAA + related) → suggestions/ideas expansion → enrich (volume + KD + intent) → classify into Compact Keywords pillars → score → cluster into page targets. See \`.skills/${SKILL_ID}/SKILL.md\`.

**Pool:** ${candidates.length} candidates enriched, **${qualified.length} qualified** (measurable demand or direct product-fit), clustering into **${pageTargets.length} page targets**.
**Cost:** ${apiCalls} live API calls (${cacheHits} served from cache).

> **Priority** is a 0–100 composite favoring rankability (KD) × intent × product-fit over raw volume — the bottom-of-funnel thesis. \`product_fit\` flags queries the product answers directly.

## Page targets — build these (clustered) — top 30

Per playbook §3.8, the real deliverable is a **page count, not a flat keyword list**. Each row below is one compact page (primary keyword + N on-page variants merged via DataForSEO's \`core_keyword\`). **Cluster vol** sums the whole cluster's monthly searches.

| # | Primary keyword | Cluster vol | KD | Pillar | Variants |
|---|---|---|---|---|---|
${pageTargets
  .slice(0, 30)
  .map(
    (p, i) =>
      `| ${i + 1} | ${p.keyword} | ${p.cluster_volume} | ${p.keyword_difficulty ?? '—'} | ${p.pillar} | ${p.variant_count} |`
  )
  .join('\n')}

## Top 30 keywords overall (un-clustered)

${tableHead}
${qualified.slice(0, 30).map(fmtRow).join('\n')}

## By pillar

${section('Category keywords — what the product is', byPillar('category'))}
${section('Comparison / alternative keywords', byPillar('comparison'))}
${section('Jobs-to-be-done (how-to / "what is my…")', byPillar('jtbd'))}

## How to read this

- **Vol** — US monthly Google searches (DataForSEO). Low volume is fine for BOFU; a 50-vol query at 15% conversion beats a 5,000-vol query at 0.5%.
- **Intent** — DataForSEO's classification. For a generator product, \`informational\` how-to queries are still BOFU: the quiz *is* the answer. Trust \`product_fit\` over raw intent for those.
- **KD** — keyword difficulty 0–100. New domain target: KD < 20 (build now), KD 20–35 (build, expect link-building), KD > 35 (defer).
- **Sources** — how the candidate surfaced (seed / synthetic modifier-stack / serp_related / serp_paa / suggestion / idea / competitor / jtbd).

Full machine-readable data: \`.supertools-state/${SKILL_ID}/keywords.json\` · CSV: \`report.csv\`.
`;

const docsDir = path.join(PROJECT_ROOT, 'docs', 'seo');
await fsp.mkdir(docsDir, { recursive: true });
const docOut = path.join(docsDir, `keyword-discovery-${niche.niche}.md`);
await fsp.writeFile(docOut, md);
await fsp.writeFile(path.join(WORK, 'report.md'), md);

// ===== Receipt =====
await writeReceipt(SKILL_ID, `Discovered ${qualified.length} qualified keyword targets for "${niche.niche}".`, {
  niche: niche.niche,
  nicheProfile: path.relative(PROJECT_ROOT, nichePath),
  transport: dfsTransport(),
  candidateCount: candidates.length,
  enrichedCount: enriched.size,
  qualifiedCount: qualified.length,
  pageTargetCount: pageTargets.length,
  apiCalls,
  cacheHits,
  report: path.relative(PROJECT_ROOT, docOut),
  data: path.relative(PROJECT_ROOT, path.join(WORK, 'keywords.json')),
  csv: path.relative(PROJECT_ROOT, path.join(WORK, 'report.csv')),
  topTargets: qualified.slice(0, 10).map((r) => ({
    keyword: r.keyword,
    volume: r.search_volume,
    intent: r.dfs_intent,
    kd: r.keyword_difficulty,
    pillar: r.pillar,
    priority: r.priority,
  })),
});

console.log('\n---SETUP_DONE---');
console.log(
  JSON.stringify(
    {
      status: 'ok',
      niche: niche.niche,
      candidates: candidates.length,
      enriched: enriched.size,
      qualified: qualified.length,
      pageTargets: pageTargets.length,
      apiCalls,
      cacheHits,
      report: path.relative(PROJECT_ROOT, docOut),
      top5: qualified.slice(0, 5).map((r) => `${r.keyword} (v=${r.search_volume ?? '?'}, kd=${r.keyword_difficulty ?? '?'}, ${r.pillar})`),
    },
    null,
    2
  )
);
