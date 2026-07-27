#!/usr/bin/env node
// seo-01b-content-map — turn seo-01's flat keyword targets into a deliberate
// hub-and-spoke + funnel content architecture, BEFORE any page is built, so we
// ship an interlinked authority graph (not 660 orphaned pages) and never let two
// pages cannibalize each other.
//
// Sits between seo-01 (keyword-targets@1) and seo-02 (serp-briefs). Consumes
// keyword-targets@1; produces content-map@1 (clusters + funnel tags + link graph
// + cannibalization guards + a prioritized build queue) for seo-02/04/05.
//
// Philosophy (the "dual-indexed graph, anchored on conversion"):
//   - Clusters are the architecture: subject topics -> hub + spokes (a hub needs
//     >=4 modifier-extension spokes; no singleton hubs). [content-architecture-clusters.md]
//   - Funnel stage is a TAG overlay derived per page by an ordered cascade; each
//     cluster anchors DOWN onto a conversion page (its own tool, else the global
//     quiz / palette tool). TOFU/MOFU/BOFU "hubs" are navigational index views
//     over the one corpus. [content-funnel-mapping.md]
//   - Cannibalization guard: unique primary_intent_key=(intent_class,topic,
//     differentiator) per page; intent_class in the key keeps tool-vs-browse
//     apart; subject modifiers (color/season/style) stay distinct (the moat).
//     SERP-overlap confirmation is deferred to seo-02. [content-cannibalization.md]
//
// Deterministic + idempotent: pure functions over the upstream artifact + config.
// No network. Re-run safely; output is a function of (targets, config).
//
// Usage:
//   node .skills/seo-01b-content-map/setup.mjs [--config config.<name>.json]

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';
import { resolveProjectConfig } from '../_shared/project.mjs';
import { STATE_DIR, writeReceipt } from '../_shared/state.mjs';
import { readUpstream, assertSchema, recordConsumes, printDone, pickArg, hashObj } from '../_shared/seo.mjs';
import { buildPages, dedupe, clusterize, linkGraph, urlPlan, sequence, validate } from './cluster.mjs';

const SKILL_ID = 'seo-01b-content-map';
const UPSTREAM = 'seo-01-keyword-discovery';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(STATE_DIR, SKILL_ID);
const DOCS = path.join(PROJECT_ROOT, 'docs', 'seo');

const argv = process.argv.slice(2);
const cfgArg = pickArg(argv, '--config');
const cfgPath = cfgArg ? path.join(HERE, cfgArg) : resolveProjectConfig(HERE, 'config');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
const cfgHash = hashObj(cfg); // tracked in the receipt so a config edit marks the chain stale

// ===== Read upstream =====
const { data, hash } = await readUpstream(UPSTREAM, 'keywords.json');
assertSchema(data, 'keyword-targets@1');
const targets = data.page_targets || [];
console.log(`[content-map] read ${targets.length} page targets from ${UPSTREAM}`);

// ===== Build the map =====
const decorated = buildPages(targets, cfg);
// Quarantine off-topic + competitor/branded targets BEFORE the architecture so
// they never reach pages/build_queue/funnel hubs/anchors (codex review fix).
const buildable = decorated.filter((p) => !p.quarantined);
const quarantined = decorated.filter((p) => p.quarantined);
console.log(`[content-map] quarantined ${quarantined.length} off-topic/branded target(s); ${buildable.length} buildable`);
const { pages: deduped, merges } = dedupe(buildable);
console.log(`[content-map] cannibalization pass: ${buildable.length} -> ${deduped.length} pages (${merges.length} merge group(s))`);

const allClusters = clusterize(deduped, cfg);
// Below-threshold real topics (<min spokes) are NOT clusters — no singleton hubs.
// Their members lift out as lateral_pages for manual attachment to a neighbor.
let clusters = allClusters.filter((c) => !c.unmapped && !c.below_threshold);
const lateralPages = allClusters.filter((c) => c.below_threshold).flatMap((c) => c.members);
const pages = clusters.flatMap((c) => c.members);
clusters = linkGraph(clusters, cfg);
clusters = urlPlan(clusters, cfg);
const { build_queue, first_wave, first_wave_clusters } = sequence(clusters, cfg);
const validators = validate(clusters, pages, cfg);
console.log(`[content-map] ${clusters.length} clusters (${lateralPages.length} lateral); first wave = ${first_wave_clusters.join(', ')}`);

// ===== Funnel hubs (navigational index views over the corpus) =====
const funnelHubs = {};
for (const [stage, meta] of Object.entries(cfg.funnel_hubs)) {
  if (stage.startsWith('_')) continue; // skip config comments
  funnelHubs[stage] = { path: meta.path, label: meta.label, pages: pages.filter((p) => p.funnel_stage === stage).map((p) => p.slug) };
}
const funnelCounts = { TOFU: 0, MOFU: 0, BOFU: 0 };
for (const p of pages) funnelCounts[p.funnel_stage]++;

// ===== Head-term ownership registry (cannibalization R4) =====
const headTermOwners = {};
for (const c of clusters) if (c.hub_slug) headTermOwners[c.label] = c.hub_slug;

// ===== Assemble + write the artifact =====
const artifact = {
  schema_version: 'content-map@1',
  niche: data.niche,
  generated_at: new Date().toISOString(),
  source: { producer: UPSTREAM, hash, page_target_count: targets.length, config_hash: cfgHash },
  philosophy: 'dual-indexed graph (subject clusters x funnel-stage tags), anchored on conversion; one page per primary_intent_key',
  summary: {
    buildable_pages: pages.length,
    clusters: clusters.length,
    hubs: clusters.filter((c) => c.hub_slug).length,
    spokes: pages.filter((p) => p.role === 'spoke').length,
    merged_away: merges.reduce((s, m) => s + m.merged.length, 0),
    quarantined: quarantined.length,
    lateral: lateralPages.length,
    funnel: funnelCounts,
    orphans: validators.orphans.length,
    clusters_needing_hub: validators.no_hub_clusters.length,
    // accounting: every upstream target is buildable, merged-away, quarantined, or lateral.
    accounting: { upstream: targets.length, buildable: pages.length, merged_away: merges.reduce((s, m) => s + m.merged.length, 0), quarantined: quarantined.length, lateral: lateralPages.length },
  },
  cluster_score_formula: 'log10(cluster_volume+1) * (100-median_kd)/100 * (0.5 + fit_share/2) * (min(1, members/12)+0.3)',
  clusters: clusters.map((c) => ({
    id: c.id, label: c.label, slug: c.slug, rank: c.rank, score: c.score,
    hub_type: c.hub_type, hub_slug: c.hub_slug, hub_needed: c.hub_needed,
    anchor: c.anchor, spoke_count: c.spoke_count, cluster_volume: c.cluster_volume,
    median_kd: c.median_kd, fit_share: c.fit_share,
    flags: {
      singleton: c.singleton, geo_below_threshold: c.geo_below_threshold,
      split_recommended: c.split_recommended, low_fit: c.low_fit,
    },
    page_slugs: c.members.map((m) => m.slug),
  })),
  pages: clusters.flatMap((c) => c.members).map((p) => ({
    slug: p.slug, keyword: p.keyword, url_path: p.url_path, role: p.role,
    cluster: p.topic, funnel_stage: p.funnel_stage, funnel_confidence: p.funnel_confidence,
    funnel_reason: p.funnel_reason, funnel_hub: p.funnel_hub, intent_class: p.intent_class,
    pillar: p.pillar, product_fit: p.product_fit, template: p.template, cta_strength: p.cta_strength,
    primary_intent_key: p.primary_intent_key, differentiator: p.differentiator, diff_class: p.diff_class,
    is_tool: p.is_tool, cluster_anchor: !!p.cluster_anchor,
    cluster_volume: p.cluster_volume, keyword_difficulty: p.keyword_difficulty, priority: p.priority,
    inbound_links: p.inbound, links: p.links, variants: p.variants,
  })),
  funnel_hubs: funnelHubs,
  build_queue,
  first_wave: { cluster_ids: first_wave_clusters, page_slugs: first_wave },
  cannibalization: { merges, head_term_owners: headTermOwners, serp_overlap_note: 'Lexical+intent+modifier merge done at map stage; SERP-overlap (>=60% shared top-10) confirmation deferred to seo-02 which captures live SERPs.' },
  // Off-topic + competitor/branded targets, held OUT of the buildable corpus.
  quarantined_targets: quarantined
    .map((p) => ({ keyword: p.keyword, slug: p.slug, reason: p.quarantine_reason, branded: p.branded, cluster_volume: p.cluster_volume }))
    .sort((a, b) => b.cluster_volume - a.cluster_volume),
  // Real-topic targets below the hub threshold: attach manually to a neighbor
  // cluster (no singleton hub). Held out of the buildable graph + build queue.
  lateral_pages: lateralPages
    .map((p) => ({ keyword: p.keyword, slug: p.slug, topic: p.topic, funnel_stage: p.funnel_stage, cluster_volume: p.cluster_volume, reason: 'below min-cluster-size — attach laterally to nearest cluster' }))
    .sort((a, b) => b.cluster_volume - a.cluster_volume),
  validators,
};

await fsp.mkdir(WORK, { recursive: true });
await fsp.writeFile(path.join(WORK, 'content-map.json'), JSON.stringify(artifact, null, 2));

// ===== Human-readable report =====
const md = renderReport(artifact, clusters, cfg);
await fsp.mkdir(DOCS, { recursive: true });
await fsp.writeFile(path.join(DOCS, `content-map-${readProject().projectName}.md`), md);
await fsp.writeFile(path.join(WORK, 'report.md'), md);

// ===== Receipt (records upstream hash for staleness) =====
await writeReceipt(SKILL_ID, artifact.summary, {
  provides: ['content-map'],
  config_hash: cfgHash,
  consumes: recordConsumes([{ producerId: UPSTREAM, file: 'keywords.json', hash }]),
  data: path.relative(PROJECT_ROOT, path.join(WORK, 'content-map.json')),
  report: path.relative(PROJECT_ROOT, path.join(DOCS, `content-map-${readProject().projectName}.md`)),
});

printDone({
  buildable_pages: artifact.summary.buildable_pages,
  clusters: artifact.summary.clusters,
  funnel: funnelCounts,
  merged_away: artifact.summary.merged_away,
  quarantined: quarantined.length,
  first_wave_clusters,
  orphans: validators.orphans.length,
  data: path.relative(PROJECT_ROOT, path.join(WORK, 'content-map.json')),
  report: path.relative(PROJECT_ROOT, path.join(DOCS, `content-map-${readProject().projectName}.md`)),
});

// ---- report renderer ----
function renderReport(a, clusters, cfg) {
  const L = [];
  L.push(`# ${readProject().brandName} Content Map`, '');
  L.push(`**Generated:** ${a.generated_at.slice(0, 10)} · **Source:** ${a.source.producer} (${a.source.page_target_count} targets) · **Skill:** \`${SKILL_ID}\``, '');
  L.push(`> ${a.philosophy}`, '');
  L.push(`Turns the flat keyword list into a **hub-and-spoke + funnel** architecture before page production. Clusters are the structure; funnel stage is a tag; every page has a unique \`primary_intent_key\` so no two pages compete. Build order is BOFU-first, cluster-complete. Strategy + rules: [architecture](../research/content-architecture-clusters.md) · [funnel](../research/content-funnel-mapping.md) · [cannibalization](../research/content-cannibalization.md), reconciled against [the Compact Keywords playbook](../compact-keywords-guide.md).`, '');

  L.push(`## Summary`, '');
  const s = a.summary;
  L.push(`- **${s.buildable_pages}** buildable pages across **${s.clusters}** clusters (${s.hubs} with a hub, ${s.spokes} spokes).`);
  L.push(`- Cannibalization: **${s.merged_away}** near-duplicate targets merged away (${a.cannibalization.merges.length} groups).`);
  L.push(`- Quarantined (off-topic + competitor/branded, NOT built): **${s.quarantined}**.`);
  L.push(`- Accounting: ${s.accounting.upstream} upstream = ${s.accounting.buildable} buildable + ${s.accounting.merged_away} merged + ${s.accounting.quarantined} quarantined.`);
  L.push(`- Funnel split: **${s.funnel.BOFU} BOFU · ${s.funnel.MOFU} MOFU · ${s.funnel.TOFU} TOFU**.`);
  L.push(`- Gates: ${s.orphans} orphans · ${s.clusters_needing_hub} clusters need a hub page created · ${s.lateral} lateral page(s) below cluster size.`, '');

  L.push(`## First wave (build these first, cluster-complete)`, '');
  L.push(`Top ${cfg.thresholds.first_wave_clusters} clusters by score, each shipped as a thin hub + its first ≥${cfg.thresholds.min_spokes_for_hub} spokes (architecture §6):`, '');
  for (const id of a.first_wave.cluster_ids) {
    const c = clusters.find((x) => x.id === id);
    L.push(`- **${c.label}** (rank ${c.rank}, score ${c.score}, vol ${c.cluster_volume.toLocaleString()}, ${c.spoke_count} spokes) → anchor: ${c.anchor.type === 'page' ? c.anchor.slug : c.anchor.url}`);
  }
  L.push('');

  L.push(`## Clusters (by build priority)`, '');
  for (const c of clusters.filter((x) => !x.unmapped)) {
    const hub = c.members.find((m) => m.role === 'hub');
    const flags = [c.singleton && 'SINGLETON', c.geo_below_threshold && '<5 spokes (below AI-citation threshold)', c.split_recommended && `SPLIT (${c.spoke_count} spokes — sub-divide by modifier)`, c.low_fit && 'low product-fit'].filter(Boolean);
    L.push(`### ${c.rank}. ${c.label}  ·  score ${c.score}`);
    const hubLine = hub
      ? `\`${hub.keyword}\` → ${hub.url_path}${c.interim_hub ? ` _(interim — create a dedicated \`${c.hub_needed}\` hub page)_` : ''}`
      : `_none — create \`${c.hub_needed}\`_`;
    L.push(`- **Hub:** ${hubLine}  ·  **type:** ${c.hub_type}`);
    L.push(`- **BOFU anchor:** ${c.anchor.type === 'page' ? `\`${c.anchor.slug}\`` : `${c.anchor.label} (${c.anchor.url})`}`);
    L.push(`- **Volume:** ${c.cluster_volume.toLocaleString()}  ·  **median KD:** ${c.median_kd ?? 'n/a'}  ·  **fit:** ${Math.round(c.fit_share * 100)}%  ·  **spokes:** ${c.spoke_count}`);
    if (flags.length) L.push(`- **Flags:** ${flags.join(' · ')}`);
    const sample = c.members.filter((m) => m.role === 'spoke').slice(0, 6).map((m) => `${m.keyword} _(${m.funnel_stage})_`);
    if (sample.length) L.push(`- **Spokes (sample):** ${sample.join('; ')}${c.spoke_count > 6 ? ` … +${c.spoke_count - 6}` : ''}`);
    L.push('');
  }
  const q = a.quarantined_targets || [];
  if (q.length) {
    const branded = q.filter((x) => x.branded);
    L.push(`### Quarantined (held out of the buildable corpus)`, '');
    L.push(`**${q.length}** targets are excluded from \`pages\`, \`build_queue\`, and the funnel hubs — they are never briefed or built:`, '');
    L.push(`- **${q.length - branded.length}** off-topic / off-product (no subject match): e.g. ${q.filter((x) => !x.branded).slice(0, 8).map((x) => `\`${x.keyword}\``).join(', ')} …`);
    if (branded.length) L.push(`- **${branded.length}** competitor / branded (never built, never linked — the no-competitor rule): e.g. ${branded.slice(0, 8).map((x) => `\`${x.keyword}\``).join(', ')} …`);
    L.push(`A large off-topic bucket signals seo-01's disqualification (playbook §3.4) is too loose; tighten the niche profile and re-run discovery.`, '');
  }

  L.push(`## Funnel hubs (navigational index views)`, '');
  for (const [stage, h] of Object.entries(a.funnel_hubs)) L.push(`- **${stage}** → \`${h.path}\` (${h.label}): ${h.pages.length} pages`);
  L.push('');

  if (a.cannibalization.merges.length) {
    L.push(`## Cannibalization merges (one page per intent)`, '');
    L.push(`Same \`primary_intent_key\` → folded into one page (the rest become on-page variants). SERP-overlap confirmation runs in seo-02.`, '');
    for (const m of a.cannibalization.merges.slice(0, 30)) L.push(`- \`${m.kept_keyword}\` ← ${m.merged.map((x) => `\`${x}\``).join(', ')}`);
    if (a.cannibalization.merges.length > 30) L.push(`- … +${a.cannibalization.merges.length - 30} more`);
    L.push('');
  }

  const v = a.validators;
  L.push(`## Review queue (human sign-off)`, '');
  L.push(`- **Clusters needing a hub page created:** ${v.no_hub_clusters.join(', ') || 'none'}`);
  L.push(`- **Lateral pages (below cluster size — attach to a neighbor manually):** ${(a.lateral_pages || []).map((x) => `\`${x.keyword}\``).join(', ') || 'none'}`);
  L.push(`- **Oversize clusters (split recommended):** ${v.split_recommended.map((x) => `${x.id} (${x.spokes})`).join(', ') || 'none'}`);
  L.push(`- **Below AI-citation threshold (<5 spokes):** ${v.geo_below.join(', ') || 'none'}`);
  L.push(`- **Orphans (no inbound link):** ${v.orphans.join(', ') || 'none'}`);
  L.push(`- **Defaulted funnel calls (low confidence, mostly inspiration → TOFU; expected for this niche, spot-check a sample):** ${v.needs_review.length}`);
  L.push('');
  L.push(`---`, `_Deterministic output of \`${SKILL_ID}\` over ${a.source.producer}. Re-run after seo-01 changes; \`verify.mjs\` flags a stale chain._`);
  return L.join('\n');
}
