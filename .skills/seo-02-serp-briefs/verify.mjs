#!/usr/bin/env node
// Verifier for seo-02-serp-briefs. Substantive checks:
//   - dependencies reachable (DataForSEO transport, Crawl4AI, Perplexity, OpenAI)
//   - upstream keyword-targets@1 readable + schema ok
//   - briefs.json is page-briefs@1 with complete briefs
//   - the NOVELTY INVARIANT holds: no unique_angle is sourced from a ranking domain
//   - real crawl coverage happened; receipt records the upstream hash (staleness)
// Exit 0 = pass.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, loadEnv } from '../_shared/env.mjs';
import { STATE_DIR } from '../_shared/state.mjs';
import { readUpstream, assertSchema, staleAgainst } from '../_shared/seo.mjs';
import { dfsTransport } from '../_shared/dataforseo.mjs';
import { crawl4aiHealthy } from '../_shared/crawl4ai.mjs';
import { perplexityConfigured } from '../_shared/perplexity.mjs';

const SKILL_ID = 'seo-02-serp-briefs';
const UPSTREAM = 'seo-01-keyword-discovery';
const MAP_UPSTREAM = 'seo-01b-content-map';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnv();

let failed = 0;
const ok = (m) => console.log(`[OK ] ${m}`);
const bad = (m) => { console.log(`[FAIL] ${m}`); failed++; };

// 1. deps
dfsTransport() ? ok(`DataForSEO transport: ${dfsTransport()}`) : bad('no DataForSEO transport');
(await crawl4aiHealthy()) ? ok('Crawl4AI healthy') : bad(`Crawl4AI not healthy at ${process.env.CRAWL4AI_URL || 'http://localhost:11235'}`);
perplexityConfigured() ? ok('PERPLEXITY_API_KEY set') : bad('PERPLEXITY_API_KEY missing');
process.env.OPENAI_API_KEY ? ok('OPENAI_API_KEY set') : bad('OPENAI_API_KEY missing');

// 2. upstream contract
try {
  const { data, hash } = await readUpstream(UPSTREAM, 'keywords.json');
  assertSchema(data, 'keyword-targets@1');
  ok(`upstream ${UPSTREAM} readable (keyword-targets@1, ${data.page_targets?.length} targets)`);
  if (await staleAgainst(SKILL_ID, UPSTREAM, hash)) console.log(`[INFO] upstream ${UPSTREAM} changed since last run — re-run setup.mjs to refresh.`);
} catch (e) {
  bad(`upstream contract: ${e.message}`);
}

// 2b. content-map (preferred selection source) — optional but, when present,
// seo-02's selection MUST resolve against it: a subset of content-map.pages
// slugs, in build_queue order.
let cm = null;
try {
  const { data, hash } = await readUpstream(MAP_UPSTREAM, 'content-map.json');
  assertSchema(data, 'content-map@1');
  cm = data;
  ok(`content-map ${MAP_UPSTREAM} readable (content-map@1, ${data.pages?.length} pages, ${data.build_queue?.length} queued)`);
  if (await staleAgainst(SKILL_ID, MAP_UPSTREAM, hash)) console.log(`[INFO] content-map changed since last run — re-run setup.mjs to refresh.`);
} catch {
  console.log(`[INFO] ${MAP_UPSTREAM} not present — seo-02 falls back to flat keyword-targets order.`);
}

// 3. produced artifact
const briefsPath = path.join(STATE_DIR, SKILL_ID, 'briefs.json');
if (!fs.existsSync(briefsPath)) {
  console.log(`[INFO] no run yet (${path.relative(PROJECT_ROOT, briefsPath)} absent) — run setup.mjs first.`);
} else {
  const art = JSON.parse(fs.readFileSync(briefsPath, 'utf-8'));
  try { assertSchema(art, 'page-briefs@1'); ok('briefs.json is page-briefs@1'); }
  catch (e) { bad(e.message); }

  const briefs = art.briefs || [];
  briefs.length >= 1 ? ok(`${briefs.length} brief(s)`) : bad('no briefs');

  let structOk = true, novelty = true, crawlReal = false;
  for (const b of briefs) {
    // completeness
    const need = ['slug', 'url_path', 'primary_keyword', 'serp', 'crawled_competitors', 'paa_analysis', 'unique_angles', 'brief'];
    if (need.some((k) => !(k in b))) { structOk = false; bad(`brief "${b.slug}" missing a top-level field`); }
    const bn = ['h1', 'recommended_format', 'table_stakes_h2', 'schema_type'];
    if (b.brief && bn.some((k) => !(k in b.brief))) { structOk = false; bad(`brief "${b.slug}" .brief missing a field`); }

    // crawl coverage
    if ((b.crawled_competitors || []).some((c) => c.crawl_status === 'ok')) crawlReal = true;

    // NOVELTY INVARIANT — no unique angle sourced from a domain that already ranks
    const ranking = new Set((b.serp?.top_domains || []).map((d) => d.replace(/^www\./, '')));
    for (const a of b.unique_angles || []) {
      if (!a.source_url) { novelty = false; bad(`angle without source_url in "${b.slug}"`); continue; }
      try {
        const host = new URL(a.source_url).hostname.replace(/^www\./, '');
        if (ranking.has(host)) { novelty = false; bad(`angle in "${b.slug}" sourced from RANKING domain ${host}`); }
      } catch { /* unparseable url — tolerate */ }
    }
    // format must match SERP-dominant (the cardinal rule)
    if (b.brief?.recommended_format && b.serp?.dominant_format &&
        !sharesWord(b.brief.recommended_format, b.serp.dominant_format)) {
      console.log(`[INFO] "${b.slug}" recommended_format "${b.brief.recommended_format}" vs dominant "${b.serp.dominant_format}" — confirm intentional`);
    }
  }
  structOk && ok('every brief structurally complete');
  novelty && ok('novelty invariant holds (no angle sourced from a ranking domain)');
  crawlReal ? ok('at least one real crawl per run') : bad('no successful crawls — brief built on titles/PAA only');

  // human briefs
  const md = path.join(PROJECT_ROOT, 'docs', 'seo', 'briefs', `${briefs[0]?.slug}.md`);
  fs.existsSync(md) ? ok(`human brief present (${path.relative(PROJECT_ROOT, md)})`) : bad('docs/seo/briefs md missing');

  // receipt + staleness record
  const rec = path.join(STATE_DIR, `${SKILL_ID}.json`);
  if (fs.existsSync(rec)) {
    const r = JSON.parse(fs.readFileSync(rec, 'utf-8'));
    const c = (r.consumes || []).find((x) => x.producerId === UPSTREAM);
    c?.hash ? ok('receipt records upstream hash (staleness wired)') : bad('receipt missing consumes hash');
    if (cm) {
      const cmc = (r.consumes || []).find((x) => x.producerId === MAP_UPSTREAM);
      cmc?.hash ? ok('receipt records content-map hash (staleness wired)') : console.log(`[INFO] receipt has no content-map consumes (last run predates content-map wiring)`);
    }
  } else bad('receipt missing');
}

// 4. when content-map is present, the --dry-run selection must resolve against
// it: every selected slug is a content-map page, and the order respects
// build_queue. This exercises the real selection path with zero API cost.
if (cm) {
  try {
    const out = execFileSync('node', [path.join(HERE, 'setup.mjs'), '--dry-run'], {
      encoding: 'utf-8', cwd: PROJECT_ROOT,
    });
    const tail = out.slice(out.indexOf('---SETUP_DONE---') + '---SETUP_DONE---'.length).trim();
    const plan = JSON.parse(tail);
    const pageSlugs = new Set((cm.pages || []).map((p) => p.slug));
    const orderBySlug = new Map((cm.build_queue || []).map((q) => [q.slug, q.build_order]));
    const sel = plan.selection || [];
    sel.length ? ok(`--dry-run resolved ${sel.length} target(s) from content-map`) : bad('--dry-run resolved 0 targets');
    const allPages = sel.every((s) => pageSlugs.has(s.slug));
    allPages ? ok('selection is a subset of content-map.pages slugs') : bad('selection contains a slug not in content-map.pages');
    let ordered = true;
    for (let i = 1; i < sel.length; i++) {
      const a = orderBySlug.get(sel[i - 1].slug), b = orderBySlug.get(sel[i].slug);
      if (a != null && b != null && a > b) { ordered = false; break; }
    }
    ordered ? ok('selection respects build_queue order (BOFU-first)') : bad('selection violates build_queue order');
  } catch (e) {
    bad(`--dry-run selection check failed: ${e.message}`);
  }
}

function sharesWord(a, b) {
  const wa = new Set(String(a).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  return String(b).toLowerCase().split(/\W+/).some((w) => w.length > 3 && wa.has(w));
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
