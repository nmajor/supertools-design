#!/usr/bin/env node
// Verifier for seo-01b-content-map — a HARD finalization gate (deterministic,
// offline skill, so it must have run and its invariants must hold):
//   - upstream keyword-targets@1 readable AND not stale (hash + config unchanged)
//   - content-map@1 artifact + report + receipt all present (absence FAILS)
//   - exact coverage: every upstream target keyword is a page, merge, quarantine,
//     or lateral entry — exactly once (set equality, not just counts)
//   - quarantine is real: no off-topic/branded slug in pages/build_queue/hubs
//   - anchors are owned: every cluster anchor is product_fit+non-nav, or a global
//     conversion URL (never a competitor/branded or off-product page)
//   - no singleton hubs: every emitted cluster is >= min size; below-threshold
//     topics are lateral_pages, not hubs
//   - unique primary_intent_key; single-owned head terms; no orphan spokes
//   - funnel hubs partition the corpus exactly; first wave includes its anchors
//   - build queue: no spoke before its hub
// Exit 0 = pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../_shared/env.mjs';
import { resolveProjectConfig } from '../_shared/project.mjs';
import { STATE_DIR } from '../_shared/state.mjs';
import { readUpstream, assertSchema, staleAgainst, hashObj } from '../_shared/seo.mjs';

const SKILL_ID = 'seo-01b-content-map';
const UPSTREAM = 'seo-01-keyword-discovery';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(resolveProjectConfig(HERE, 'config'), 'utf-8'));
const cfgHash = hashObj(cfg);
const CONVERSION_URLS = new Set(Object.values(cfg.conversion).map((c) => c.url));
const MIN = cfg.thresholds.min_spokes_for_hub;

let failed = 0;
const ok = (m) => console.log(`[OK ] ${m}`);
const bad = (m) => { console.log(`[FAIL] ${m}`); failed++; };

let upstreamCount = 0;
let upstreamKeywords = new Set();
try {
  const { data, hash } = await readUpstream(UPSTREAM, 'keywords.json');
  assertSchema(data, 'keyword-targets@1');
  const t = data.page_targets || [];
  upstreamCount = t.length;
  upstreamKeywords = new Set(t.map((x) => x.keyword));
  ok(`upstream ${UPSTREAM} readable (keyword-targets@1, ${upstreamCount} targets)`);
  // HARD staleness gate: upstream must not have changed since this skill last ran.
  const stale = await staleAgainst(SKILL_ID, UPSTREAM, hash);
  stale === true ? bad('upstream changed since last run — re-run setup.mjs (stale chain)') : ok('upstream unchanged since last run');
} catch (e) {
  bad(`upstream contract: ${e.message}`);
}

// Artifact MUST exist (deterministic offline skill — absence is a failure).
const artPath = path.join(STATE_DIR, SKILL_ID, 'content-map.json');
if (!fs.existsSync(artPath)) {
  bad(`artifact absent (${path.relative(PROJECT_ROOT, artPath)}) — run setup.mjs`);
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}

const a = JSON.parse(fs.readFileSync(artPath, 'utf-8'));
try { assertSchema(a, 'content-map@1'); ok('content-map.json is content-map@1'); } catch (e) { bad(e.message); }

const pages = a.pages || [];
const clusters = a.clusters || [];
pages.length >= 1 ? ok(`${pages.length} pages, ${clusters.length} clusters`) : bad('no pages');

// Config hash gate: a config edit since the last run means the map is stale.
a.source?.config_hash === cfgHash ? ok('config unchanged since last run') : bad(`config changed since last run (artifact ${a.source?.config_hash} ≠ ${cfgHash}) — re-run setup.mjs`);

// Exact coverage (set equality): every upstream keyword is represented exactly
// once as a page primary, a merged-away keyword, a quarantine, or a lateral page.
const merges = a.cannibalization?.merges || [];
const mergedKw = merges.flatMap((m) => m.merged);
const quarantined = a.quarantined_targets || [];
const lateral = a.lateral_pages || [];
const accountedKw = [...pages.map((p) => p.keyword), ...mergedKw, ...quarantined.map((q) => q.keyword), ...lateral.map((l) => l.keyword)];
const accountedSet = new Set(accountedKw);
if (upstreamCount) {
  const dupCount = accountedKw.length - accountedSet.size;
  const missing = [...upstreamKeywords].filter((k) => !accountedSet.has(k));
  const extra = [...accountedSet].filter((k) => !upstreamKeywords.has(k));
  dupCount === 0 && missing.length === 0 && extra.length === 0
    ? ok(`coverage exact: ${pages.length} pages + ${mergedKw.length} merged + ${quarantined.length} quarantined + ${lateral.length} lateral = ${upstreamCount} keywords (set-equal)`)
    : bad(`coverage drift: ${dupCount} dup, ${missing.length} missing, ${extra.length} extra (e.g. missing ${missing.slice(0, 3).join(', ')})`);
}

// Quarantine + lateral are REAL: their slugs never appear in the buildable corpus.
const slugSet = new Set(pages.map((p) => p.slug));
const queueSlugs = new Set((a.build_queue || []).map((q) => q.slug));
const hubMembership = Object.values(a.funnel_hubs || {}).flatMap((h) => h.pages);
const hubSetAll = new Set(hubMembership);
const heldOut = [...quarantined.map((x) => x.slug), ...lateral.map((x) => x.slug)];
const leak = heldOut.filter((s) => slugSet.has(s) || queueSlugs.has(s) || hubSetAll.has(s));
leak.length === 0
  ? ok('quarantine + lateral are real: 0 held-out targets in pages/build_queue/funnel hubs')
  : bad(`held-out leak: ${leak.slice(0, 6).join(', ')} appear in the buildable corpus`);

// No singleton hubs: every emitted cluster is >= MIN members (spokes + hub).
const undersized = clusters.filter((c) => (c.spoke_count || 0) + (c.hub_slug ? 1 : 0) < MIN).map((c) => `${c.id}(${c.spoke_count})`);
undersized.length === 0
  ? ok(`no singleton hubs: every cluster has >= ${MIN} pages`)
  : bad(`undersized cluster(s) emitted as hubs: ${undersized.join(', ')}`);

// Anchors are SAFE: configured global conversion URL, or an owned page
// (product_fit + non-navigational). Never competitor/branded/off-product.
const pageBySlug = new Map(pages.map((p) => [p.slug, p]));
const badAnchors = [];
for (const c of clusters) {
  const an = c.anchor;
  if (!an) { badAnchors.push(`${c.id}:none`); continue; }
  if (an.type === 'global') { if (!CONVERSION_URLS.has(an.url)) badAnchors.push(`${c.id}:${an.url}`); continue; }
  const pg = pageBySlug.get(an.slug);
  if (!pg || !pg.product_fit || pg.intent_class === 'navigational') badAnchors.push(`${c.id}:${an.slug}`);
}
badAnchors.length === 0
  ? ok('every cluster anchor is an owned conversion page or a global conversion URL')
  : bad(`invalid/off-product/branded anchor(s): ${badAnchors.join(', ')}`);

// Cannibalization invariant: primary_intent_key unique across pages.
const keys = pages.map((p) => p.primary_intent_key);
const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
dupKeys.length === 0
  ? ok('cannibalization invariant: every page has a unique primary_intent_key')
  : bad(`primary_intent_key collisions: ${[...new Set(dupKeys)].slice(0, 5).join(' | ')}`);

// Head-term single owner.
const owners = Object.values(a.cannibalization?.head_term_owners || {});
owners.length === new Set(owners).size ? ok('head terms are single-owned (one hub each)') : bad('a head term is owned by more than one page');

// Every cluster has a BOFU anchor.
const noAnchor = clusters.filter((c) => !c.anchor || (c.anchor.type === 'page' ? !c.anchor.slug : !c.anchor.url)).map((c) => c.id);
noAnchor.length === 0 ? ok('every cluster has a BOFU anchor') : bad(`clusters without a conversion anchor: ${noAnchor.join(', ')}`);

// Orphan gate: no buildable spoke with zero inbound links.
const orphans = pages.filter((p) => p.role === 'spoke' && (p.inbound_links || 0) === 0).map((p) => p.slug);
orphans.length === 0 ? ok('no orphan pages (every buildable spoke has an inbound link)') : bad(`orphan pages: ${orphans.slice(0, 8).join(', ')}`);

// Funnel hubs partition the corpus EXACTLY (HARD gate — downstream consumes them).
hubMembership.length === hubSetAll.size && hubSetAll.size === pages.length && [...slugSet].every((s) => hubSetAll.has(s))
  ? ok(`funnel hubs partition the corpus exactly (${pages.length} pages, no overlap, no omission)`)
  : bad(`funnel-hub partition broken: ${hubMembership.length} memberships / ${hubSetAll.size} unique vs ${pages.length} pages`);

// First wave is anchored on conversion: each first-wave cluster's owned anchor
// slug is present in first_wave.page_slugs.
const fwSlugs = new Set(a.first_wave?.page_slugs || []);
const fwMissingAnchor = (a.first_wave?.cluster_ids || [])
  .map((id) => clusters.find((c) => c.id === id))
  .filter((c) => c && c.anchor?.type === 'page' && !fwSlugs.has(c.anchor.slug))
  .map((c) => `${c.id}:${c.anchor.slug}`);
fwMissingAnchor.length === 0
  ? ok('first wave includes each cluster owned conversion anchor')
  : bad(`first wave omits owned anchor(s): ${fwMissingAnchor.join(', ')}`);

// Build queue: no spoke before its hub.
const order = new Map((a.build_queue || []).map((q) => [q.slug, q.build_order]));
let inversions = 0;
for (const q of a.build_queue || []) if (q.gated_on && order.get(q.gated_on) > q.build_order) inversions++;
inversions === 0 ? ok('build queue: every spoke is queued after its hub') : bad(`${inversions} spoke(s) queued before their hub`);

// Receipt: present, records upstream + config hashes, names the artifact + report.
const recPath = path.join(STATE_DIR, `${SKILL_ID}.json`);
if (fs.existsSync(recPath)) {
  const r = JSON.parse(fs.readFileSync(recPath, 'utf-8'));
  (r.consumes || []).some((x) => x.producerId === UPSTREAM && x.hash) ? ok('receipt records upstream hash') : bad('receipt missing consumes hash');
  r.config_hash === cfgHash ? ok('receipt records current config hash') : bad('receipt config hash missing/stale');
  (r.provides || []).includes('content-map') ? ok('receipt provides content-map') : bad('receipt missing provides');
  r.data && fs.existsSync(path.join(PROJECT_ROOT, r.data)) ? ok('receipt data path exists') : bad('receipt data path missing');
  r.report && fs.existsSync(path.join(PROJECT_ROOT, r.report)) ? ok('receipt report path exists') : bad('receipt report path missing');
} else bad('receipt missing');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
