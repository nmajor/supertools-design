#!/usr/bin/env node
// seo-02-serp-briefs — turn keyword page-targets into research-grade content
// briefs. For each selected target:
//   1. full SERP capture (DataForSEO: organic + ads + AI Overview + PAA + related)
//   2. crawl the top-K organic bodies (Crawl4AI -> markdown)
//   3. LLM synthesis: dominant format, table-stakes H2s, gaps, PAA-gap analysis,
//      H1, PAA->FAQ, schema type, word-count target
//   4. PAA-gap = primary novelty signal; under-addressed PAA seed step 5
//   5. Perplexity differentiation research (cited, novel-vs-top10, never forced)
//   6. assemble the brief + persist all raw evidence
//
// Selection/order: PREFERS content-map@1 (seo-01b-content-map) — walks its
// build_queue (BOFU-first, hub-before-spoke, deduped ~472 pages) and resolves
// each to its full page object. Falls back to seo-01's flat page_targets order
// when the map is absent. Pillar (absent on content-map pages) is back-filled
// from seo-01's keyword-targets by slug.
//
// Consumes:  content-map@1     (seo-01b-content-map/content-map.json)   [preferred]
//            keyword-targets@1  (seo-01-keyword-discovery/keywords.json)  [fallback + pillar lookup]
// Provides:  page-briefs@1      (.supertools-state/seo-02-serp-briefs/briefs.json)
//
// Usage:
//   node .skills/seo-02-serp-briefs/setup.mjs --only "how to make a wedding mood board"
//   node .skills/seo-02-serp-briefs/setup.mjs --top 20
//   node .skills/seo-02-serp-briefs/setup.mjs --wave            # first_wave only
//   node .skills/seo-02-serp-briefs/setup.mjs --dry-run         # print selection, no API calls
//   node .skills/seo-02-serp-briefs/setup.mjs --only "…" --no-cache

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, loadEnv } from '../_shared/env.mjs';
import { resolveProjectConfig } from '../_shared/project.mjs';
import { STATE_DIR, writeState } from '../_shared/state.mjs';
import {
  readUpstream, assertSchema, slugify, diskCache, recordConsumes,
} from '../_shared/seo.mjs';
import { dfsCall, assertDfsCredentials } from '../_shared/dataforseo.mjs';
import { crawlMarkdown, crawl4aiHealthy } from '../_shared/crawl4ai.mjs';
import { perplexityResearch, perplexityConfigured } from '../_shared/perplexity.mjs';
import { isCompetitorUrl } from '../_shared/competitors.mjs';
import { chatJSON, SEO_LLM_MODEL } from '../_shared/openai.mjs';

const SKILL_ID = 'seo-02-serp-briefs';
const UPSTREAM = 'seo-01-keyword-discovery';
const MAP_UPSTREAM = 'seo-01b-content-map';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnv();

// ---------- args ----------
const argv = process.argv.slice(2);
const noCache = argv.includes('--no-cache');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const topIdx = argv.indexOf('--top');
const topArg = topIdx >= 0 ? parseInt(argv[topIdx + 1], 10) : null;
const wave = argv.includes('--wave');
const dryRun = argv.includes('--dry-run') || argv.includes('--plan');

const cfgPath = resolveProjectConfig(HERE, 'config');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
const LOCATION = cfg.location_name;
const LANGUAGE = cfg.language_code;

// ---------- preflight ----------
// --dry-run resolves + prints the selection only; it must NOT touch any paid
// service, so we skip the credential/health preflight entirely in that mode.
if (!dryRun) {
  assertDfsCredentials();
  if (!perplexityConfigured()) throw new Error('PERPLEXITY_API_KEY not set (seo-02 differentiation pass).');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set (seo-02 synthesis).');
  if (!(await crawl4aiHealthy())) {
    throw new Error(`Crawl4AI not healthy at ${process.env.CRAWL4AI_URL || 'http://localhost:11235'} (/health).`);
  }
}

// ---------- workdir ----------
const WORK = path.join(STATE_DIR, SKILL_ID);
const DIR = {
  cacheSerp: path.join(WORK, 'cache', 'serp'),
  cacheCrawl: path.join(WORK, 'cache', 'crawl'),
  cacheResearch: path.join(WORK, 'cache', 'research'),
  serp: path.join(WORK, 'serp'),
  pages: path.join(WORK, 'pages'),
  research: path.join(WORK, 'research'),
};
for (const d of Object.values(DIR)) await fsp.mkdir(d, { recursive: true });

const log = (...a) => console.log('[seo-02]', ...a);
let costPpx = 0;

// ---------- 0. upstream ----------
// seo-01 keyword-targets — always read (fallback order + pillar back-fill).
const { data: kt, hash: ktHash } = await readUpstream(UPSTREAM, 'keywords.json');
assertSchema(kt, 'keyword-targets@1');
const pillarBySlug = new Map(
  (kt.page_targets || []).map((t) => [slugify(t.keyword), t.pillar])
);

// seo-01b content-map — PREFERRED selection + ordering + enrichment.
let cm = null, cmHash = null;
try {
  const up = await readUpstream(MAP_UPSTREAM, 'content-map.json');
  assertSchema(up.data, 'content-map@1');
  cm = up.data;
  cmHash = up.hash;
} catch (e) {
  log(`[INFO] content-map not found — falling back to flat keyword-targets order; run ${MAP_UPSTREAM} for cannibalization-safe ordering. (${e.message})`);
}

// Map a content-map page object into a seo-02 `target` (preserving the legacy
// page_target shape the downstream prompts/brief expect, + carrying enrichment).
function targetFromPage(p) {
  return {
    keyword: p.keyword,
    pillar: p.pillar || pillarBySlug.get(p.slug) || 'category',
    cluster_volume: p.cluster_volume,
    keyword_difficulty: p.keyword_difficulty,
    dfs_intent: p.intent_class || p.primary_intent_key?.split('::')[0] || 'informational',
    variants: p.variants || [],
    // --- content-map enrichment (flows into the brief; never replaces above) ---
    slug: p.slug,
    funnel_stage: p.funnel_stage,
    template: p.template,
    cluster: p.cluster,
    url_path: p.url_path,
    differentiator: p.differentiator,
    role: p.role,
  };
}

let targets, selectionSource;
if (cm) {
  selectionSource = 'content-map';
  const pageBySlug = new Map((cm.pages || []).map((p) => [p.slug, p]));
  // Walk build_queue order (BOFU-first, hub-before-spoke); resolve to full pages.
  let queued = (cm.build_queue || [])
    .map((q) => pageBySlug.get(q.slug))
    .filter(Boolean);
  if (wave) {
    const waveSlugs = new Set(cm.first_wave?.page_slugs || []);
    queued = queued.filter((p) => waveSlugs.has(p.slug));
  }
  targets = queued.map(targetFromPage);
  if (only) {
    const q = only.toLowerCase().trim();
    targets = targets.filter((t) => t.keyword.toLowerCase() === q || t.keyword.toLowerCase().includes(q));
    if (!targets.length) throw new Error(`No content-map page matches --only "${only}".`);
    targets = targets.slice(0, 1);
  } else if (!wave) {
    targets = targets.slice(0, topArg || cfg.topN);
  }
} else {
  selectionSource = 'keyword-targets';
  if (wave) throw new Error('--wave requires content-map@1; run seo-01b-content-map first.');
  targets = (kt.page_targets || []).map((t) => ({ ...t }));
  if (only) {
    const q = only.toLowerCase().trim();
    targets = targets.filter((t) => t.keyword.toLowerCase() === q || t.keyword.toLowerCase().includes(q));
    if (!targets.length) throw new Error(`No page_target matches --only "${only}".`);
    targets = targets.slice(0, 1);
  } else {
    targets = targets.slice(0, topArg || cfg.topN);
  }
}

// ---------- --dry-run: print the resolved, ordered plan and EXIT before any
// DataForSEO / Crawl4AI / Perplexity / OpenAI call (the no-cost test path). ----
if (dryRun) {
  log(`[PLAN] selection source: ${selectionSource}${wave ? ' (--wave: first_wave only)' : ''}`);
  log(`[PLAN] ${targets.length} target(s), in build order:`);
  const orderBySlug = new Map((cm?.build_queue || []).map((q) => [q.slug, q.build_order]));
  targets.forEach((t, i) => {
    const ord = t.slug ? (orderBySlug.get(t.slug) ?? '?') : (i + 1);
    log(
      `  ${String(i + 1).padStart(3)}. [build_order ${String(ord).padStart(3)}] ` +
      `${(t.funnel_stage || '—').padEnd(4)} ${(t.role || '—').padEnd(6)} ` +
      `${(t.cluster || '—').padEnd(14)} "${t.keyword}"`
    );
  });
  console.log('\n---SETUP_DONE---');
  console.log(JSON.stringify({
    status: 'ok',
    dryRun: true,
    selectionSource,
    wave: !!wave,
    count: targets.length,
    selection: targets.map((t) => ({
      build_order: t.slug ? (orderBySlug.get(t.slug) ?? null) : null,
      slug: t.slug || slugify(t.keyword),
      keyword: t.keyword,
      funnel_stage: t.funnel_stage || null,
      role: t.role || null,
      cluster: t.cluster || null,
    })),
  }, null, 2));
  process.exit(0);
}

log(`processing ${targets.length} target(s) [${selectionSource}]: ${targets.map((t) => `"${t.keyword}"`).join(', ')}`);

// ======================================================================
// Stage 1 — full SERP capture
// ======================================================================
async function captureSerp(target) {
  const { value: raw } = await diskCache(DIR.cacheSerp, `serp:${target.keyword}`, async () => {
    const r = await dfsCall('serp_organic_live_advanced', {
      keyword: target.keyword,
      location_name: LOCATION,
      language_code: LANGUAGE,
      depth: cfg.serpDepth,
      people_also_ask_click_depth: cfg.paaClickDepth,
    });
    return r;
  }, { noCache });

  const items = raw.items || [];
  const organic = items
    .filter((i) => i.type === 'organic')
    .map((i) => ({
      rank: i.rank_absolute ?? i.rank_group,
      url: i.url,
      domain: i.domain,
      title: i.title,
      description: i.description,
    }))
    .filter((o) => o.url)
    .sort((a, b) => (a.rank || 99) - (b.rank || 99));

  const paaItem = items.find((i) => i.type === 'people_also_ask');
  const paa = (paaItem?.items || []).map((q) => ({
    question: q.title,
    current_answer: q.expanded_element?.[0]?.description || null,
    answer_source: q.expanded_element?.[0]?.url || null,
  })).filter((p) => p.question);

  const relItem = items.find((i) => i.type === 'related_searches');
  const related = relItem?.items || [];

  const aiItem = items.find((i) => i.type === 'ai_overview');
  const ai_overview = aiItem
    ? {
        present: true,
        text: (aiItem.items || []).map((x) => x.text || x.title).filter(Boolean).join(' ').slice(0, 1500),
        cited_sources: (aiItem.references || []).map((r) => r.url).filter(Boolean).slice(0, 10),
      }
    : { present: false };

  const features = {
    ads: items.filter((i) => i.type === 'paid').length,
    ai_overview: !!aiItem,
    video: items.some((i) => i.type === 'video' || i.type === 'short_videos'),
    reddit: organic.some((o) => /reddit\.com/.test(o.domain || '')),
    perspectives: items.some((i) => i.type === 'perspectives'),
    map_pack: items.some((i) => i.type === 'local_pack' || i.type === 'map'),
  };

  // persist raw (human/audit)
  await fsp.writeFile(path.join(DIR.serp, `${slugify(target.keyword)}.json`), JSON.stringify(raw, null, 2));

  return {
    captured_at: new Date().toISOString(),
    raw_ref: `serp/${slugify(target.keyword)}.json`,
    organic,
    top_titles: organic.slice(0, 10).map((o) => `${o.title} — ${o.domain}`),
    top_domains: [...new Set(organic.slice(0, 10).map((o) => o.domain))],
    people_also_ask: paa,
    related_searches: related,
    ai_overview,
    features,
    ctr_outlook: features.ai_overview ? 'organic + AI-citation (answer PAA crisply)' : 'organic',
  };
}

// ======================================================================
// Stage 2 — crawl top-K organic bodies
// ======================================================================
const H2_RE = /^#{2,3}\s+(.+?)\s*$/gm;
function outline(md) {
  const out = [];
  let m;
  while ((m = H2_RE.exec(md)) && out.length < 25) out.push(m[1].trim());
  return out;
}
async function crawlCompetitors(target, serp) {
  const slug = slugify(target.keyword);
  const pageDir = path.join(DIR.pages, slug);
  await fsp.mkdir(pageDir, { recursive: true });
  const top = serp.organic.slice(0, cfg.crawlTopK);
  const crawlOne = async (o) => {
      const { value } = await diskCache(DIR.cacheCrawl, `crawl:${o.url}`, () =>
        crawlMarkdown(o.url, { timeoutMs: cfg.crawlTimeoutMs, pageTimeoutMs: cfg.crawlPageTimeoutMs }), { noCache });
      if (value.success) {
        await fsp.writeFile(
          path.join(pageDir, `${String(o.rank).padStart(2, '0')}-${(o.domain || 'x').replace(/[^\w.]/g, '_')}.md`),
          value.markdown
        );
      }
      return {
        rank: o.rank,
        url: o.url,
        domain: o.domain,
        word_count: value.word_count,
        h2_outline: value.success ? outline(value.markdown) : [],
        crawl_status: value.status,
        content_ref: value.success ? `pages/${slug}/${String(o.rank).padStart(2, '0')}-${(o.domain || 'x').replace(/[^\w.]/g, '_')}.md` : null,
        _markdown: value.markdown, // kept in-memory for the LLM, not serialized
      };
  };
  // Batch to avoid starving the single local browser pool (all-at-once timed out).
  const results = [];
  const conc = cfg.crawlConcurrency || 3;
  for (let i = 0; i < top.length; i += conc) {
    results.push(...(await Promise.all(top.slice(i, i + conc).map(crawlOne))));
  }
  const okCount = results.filter((r) => r.crawl_status === 'ok').length;
  log(`  crawled ${okCount}/${top.length} top results ok (${results.map((r) => `${r.rank}:${r.crawl_status}`).join(', ')})`);
  return results;
}

// ======================================================================
// Stage 3+4 — LLM synthesis: format, table-stakes, gaps, PAA-gap analysis
// ======================================================================
function truncWords(md, n) {
  const w = md.split(/\s+/);
  return w.length <= n ? md : w.slice(0, n).join(' ') + ' …[truncated]';
}
async function analyze(target, serp, crawled) {
  const competitorBlocks = crawled
    .filter((c) => c.crawl_status === 'ok')
    .map(
      (c) =>
        `### Rank ${c.rank} — ${c.domain} (${c.word_count} words)\nH2 outline: ${
          c.h2_outline.join(' | ') || '(none)'
        }\nExcerpt:\n${truncWords(c._markdown, cfg.maxMarkdownWordsPerPage)}`
    )
    .join('\n\n---\n\n');

  const paaBlock = serp.people_also_ask
    .map((p, i) => `${i + 1}. ${p.question}${p.current_answer ? `\n   currently-surfaced answer: ${p.current_answer.slice(0, 300)}` : ''}`)
    .join('\n');

  const system =
    'You are an expert SEO content strategist. You analyze a live Google SERP and the actual content of the pages currently ranking, then produce a precise build brief for a NEW page that will match search intent AND out-help the current results. You never invent facts. Return ONLY valid JSON.';

  const prompt = `PRODUCT: ${cfg.product.name} — ${cfg.product.what}
BRAND CONSTRAINTS: ${cfg.product.brand_constraints.join(' ')}

TARGET KEYWORD: "${target.keyword}"  (pillar: ${target.pillar}; DataForSEO intent: ${target.dfs_intent}; KD: ${target.keyword_difficulty}; cluster volume: ${target.cluster_volume})
ON-PAGE KEYWORD VARIANTS: ${(target.variants || []).join(', ') || '(none)'}

TOP RANKING TITLES:
${serp.top_titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

PEOPLE ALSO ASK (Google-validated demand — for each, judge how well the CRAWLED competitors below actually answer it):
${paaBlock || '(none returned)'}

CRAWLED CONTENT OF THE CURRENTLY-RANKING PAGES:
${competitorBlocks || '(no crawls succeeded — rely on titles + PAA)'}

TASK — return a JSON object with EXACTLY these keys:
{
  "intent": "category-listicle | how-to | comparison | landing | informational",
  "dominant_format": "what format the ranking pages share (listicle, step-by-step how-to, single landing page, comparison, etc.)",
  "recommended_format": "the format OUR page must use — it MUST match dominant_format unless there is a clear mixed-intent opening; explain in 'format_rationale'",
  "format_rationale": "1-2 sentences",
  "h1": "proposed H1 containing the keyword or a close variant",
  "word_count_target": <integer ~ the median word count of the ranking pages>,
  "table_stakes_h2": ["the sections/topics that MOST ranking pages cover — required coverage"],
  "gaps": ["topics that are thin or missing across the current top results — our opening"],
  "paa_analysis": [
    { "question": "<verbatim PAA>", "relevant": true,
      "answered_by_top10": "well | thin | none",
      "opportunity": <true if relevant AND answered_by_top10 is thin or none> }
  ],
  "faq_from_paa": [ { "q": "<relevant PAA>", "a": "<concise, genuinely useful answer, 1-3 sentences>" } ],
  "schema_type": "HowTo | FAQPage | ItemList | Article",
  "differentiation_seed_questions": ["the opportunity PAA questions + any thin topics worth deeper original research"]
}
Rules: be specific to THIS keyword and what you actually saw in the crawled content. recommended_format must match what ranks. Do not fabricate.`;

  return chatJSON(prompt, { system });
}

// ======================================================================
// Stage 5 — Perplexity differentiation research (seeded by PAA gaps)
// ======================================================================
async function research(target, analysis) {
  const seeds = (analysis.differentiation_seed_questions || []).slice(0, 6);
  const slug = slugify(target.keyword);
  const prompt = `I'm writing the most genuinely useful page on the web about: "${target.keyword}" (for engaged couples planning a wedding).
The current top-ranking pages already cover the basics. I want to add SPECIFIC, FACT-BASED, CITED information that they DON'T cover well, especially around these under-answered questions:
${seeds.map((s, i) => `- ${s}`).join('\n') || '- (none flagged; surface anything non-obvious and well-sourced)'}

Give me concrete, sourced facts, data points, expert tips, or real couple experiences that would make this page uniquely helpful. Prefer specifics (numbers, named tools/methods, recent trends) over generic advice. For each point, make the source clear. If there's nothing genuinely novel and well-sourced, say so.`;
  const { value } = await diskCache(DIR.cacheResearch, `ppx:${slug}`, () =>
    perplexityResearch(prompt, { model: cfg.perplexityModel }), { noCache });
  if (value.cost) costPpx += value.cost;
  await fsp.writeFile(path.join(DIR.research, `${slug}.json`), JSON.stringify({ prompt, ...value }, null, 2));
  return value;
}

// ======================================================================
// Stage 5b — LLM filter: research -> cited, novel-vs-top10 unique_angles
// ======================================================================
async function differentiate(target, analysis, crawled, ppx, serp) {
  const topicsSeen = crawled
    .filter((c) => c.crawl_status === 'ok')
    .flatMap((c) => c.h2_outline)
    .slice(0, 60);
  // Domains that ALREADY rank — an angle sourced from one of these is, by
  // definition, not "absent from the top-10".
  const rankingDomains = new Set((serp.top_domains || []).map((d) => d.replace(/^www\./, '')));
  const system =
    'You select genuinely NOVEL, fact-based, sourced angles for an SEO page. You are strict: an angle only qualifies if it is absent or thin in the current top results AND backed by a citation FROM A SOURCE THAT IS NOT ITSELF ONE OF THE RANKING PAGES. You never fabricate, and you flag any factual claim for human verification. Return ONLY valid JSON.';
  const prompt = `TARGET: "${target.keyword}" for ${cfg.product.name}.
BRAND CONSTRAINTS: ${cfg.product.brand_constraints.join(' ')}

DOMAINS THAT ALREADY RANK (an angle whose source is one of these is NOT novel — exclude it):
${[...rankingDomains].join(', ')}

ALREADY COVERED BY THE TOP RESULTS (do NOT propose these as novel):
- table stakes: ${(analysis.table_stakes_h2 || []).join('; ')}
- competitor H2s seen: ${topicsSeen.join('; ') || '(none)'}

RESEARCH FINDINGS (from Perplexity, with citations):
${ppx.content}

CITATIONS:
${(ppx.citations || []).map((c, i) => `[${i + 1}] ${c}`).join('\n') || '(none)'}

TASK — return JSON: { "unique_angles": [ {
  "insight": "one specific, useful angle/fact to add to the page",
  "source_url": "the citation URL backing it (must be present)",
  "source_kind": "paa-gap | study | reddit | expert | data | forum",
  "confidence": "high | medium | low",
  "novelty_vs_serp": "absent | thin | contradicts",
  "needs_verification": <true if it's a factual/statistical claim>,
  "use_if": "short note on when to include it"
} ] }
Only include angles that are genuinely novel vs the top results and have a source_url. Return an empty array if nothing qualifies — do not force it.`;
  const out = await chatJSON(prompt, { system });
  let angles = Array.isArray(out.unique_angles) ? out.unique_angles : [];
  // Deterministic backstop: drop any angle whose source domain already ranks
  // (the LLM sometimes still cites a top-10 page). Honesty over volume.
  const before = angles.length;
  angles = angles.filter((a) => {
    if (!a.source_url) return false;
    if (isCompetitorUrl(a.source_url)) return false; // never cite/link a competitor
    try {
      const host = new URL(a.source_url).hostname.replace(/^www\./, '');
      return !rankingDomains.has(host);
    } catch {
      return true;
    }
  });
  if (angles.length < before) log(`  dropped ${before - angles.length} angle(s) sourced from a ranking or competitor domain`);
  return angles;
}

// ======================================================================
// Assemble + run
// ======================================================================
function urlPathFor(target, analysis) {
  // content-map carries the authoritative URL plan — prefer it when present.
  if (target.url_path) return target.url_path;
  const slug = slugify(target.keyword);
  if (target.pillar === 'jtbd') return `/guides/${slug}/`;
  return `/${slug}/`;
}

const briefs = [];
for (const target of targets) {
  log(`▶ "${target.keyword}"`);
  const serp = await captureSerp(target);
  log(`  serp: ${serp.organic.length} organic, ${serp.people_also_ask.length} PAA, AI-overview=${serp.features.ai_overview}`);
  const crawled = await crawlCompetitors(target, serp);
  const analysis = await analyze(target, serp, crawled);
  log(`  analysis: format=${analysis.recommended_format}; ${(analysis.table_stakes_h2 || []).length} table-stakes; ${(analysis.paa_analysis || []).filter((p) => p.opportunity).length} PAA opportunities`);
  const ppx = await research(target, analysis);
  const unique_angles = await differentiate(target, analysis, crawled, ppx, serp);
  log(`  differentiation: ${unique_angles.length} unique angle(s)`);

  const slug = target.slug || slugify(target.keyword);
  briefs.push({
    slug,
    url_path: urlPathFor(target, analysis),
    primary_keyword: target.keyword,
    variants: target.variants || [],
    pillar: target.pillar,
    // content-map enrichment (additive; downstream may use, never required) —
    funnel_stage: target.funnel_stage || null,
    role: target.role || null,
    template: target.template || null,
    cluster: target.cluster || null,
    differentiator: target.differentiator || null,
    intent: analysis.intent,
    serp: {
      captured_at: serp.captured_at,
      raw_ref: serp.raw_ref,
      median_word_count: analysis.word_count_target,
      dominant_format: analysis.dominant_format,
      top_titles: serp.top_titles,
      top_domains: serp.top_domains,
      people_also_ask: serp.people_also_ask.map((p) => p.question),
      related_searches: serp.related_searches,
      ai_overview: serp.ai_overview,
      features: serp.features,
      ctr_outlook: serp.ctr_outlook,
    },
    crawled_competitors: crawled.map(({ _markdown, ...c }) => c),
    paa_analysis: analysis.paa_analysis || [],
    unique_angles,
    brief: {
      h1: analysis.h1,
      recommended_format: analysis.recommended_format,
      format_rationale: analysis.format_rationale,
      table_stakes_h2: analysis.table_stakes_h2 || [],
      gaps: analysis.gaps || [],
      paa_gaps_to_win: (analysis.paa_analysis || []).filter((p) => p.opportunity).map((p) => p.question),
      differentiation: unique_angles.map((a) => a.insight),
      faq_from_paa: analysis.faq_from_paa || [],
      schema_type: analysis.schema_type,
      internal_link_anchors: [],
      primary_cta: cfg.product.primary_cta,
      cta_url: cfg.product.cta_url,
      brand_constraints: cfg.product.brand_constraints,
      word_count_target: analysis.word_count_target,
    },
    source_target: target,
    research_provenance: {
      serp_tool: 'dataforseo:serp_organic_live_advanced',
      crawler: 'crawl4ai',
      research: `perplexity:${cfg.perplexityModel}`,
      llm: SEO_LLM_MODEL,
    },
  });

  // human-readable brief
  await writeBriefMd(briefs[briefs.length - 1]);
}

// ---------- write artifact + receipt ----------
const artifact = {
  schema_version: 'page-briefs@1',
  generated_at: new Date().toISOString(),
  source: { skill: UPSTREAM, artifact_hash: ktHash },
  selection_source: selectionSource,
  ...(cm ? { content_map: { skill: MAP_UPSTREAM, artifact_hash: cmHash } } : {}),
  config: { location: LOCATION, language: LANGUAGE },
  briefs,
};
await fsp.writeFile(path.join(WORK, 'briefs.json'), JSON.stringify(artifact, null, 2));

await writeState(SKILL_ID, {
  status: 'ok',
  version: '0.1',
  timestamp: new Date().toISOString(),
  summary: `Built ${briefs.length} research-grade brief(s).`,
  provides: ['page-briefs'],
  consumes: recordConsumes([
    { producerId: UPSTREAM, artifact: 'keyword-targets', hash: ktHash },
    ...(cm ? [{ producerId: MAP_UPSTREAM, artifact: 'content-map', hash: cmHash }] : []),
  ]),
  briefCount: briefs.length,
  perplexityCostUsd: Math.round(costPpx * 10000) / 10000,
  data: path.relative(PROJECT_ROOT, path.join(WORK, 'briefs.json')),
  briefs: briefs.map((b) => ({
    slug: b.slug,
    keyword: b.primary_keyword,
    url_path: b.url_path,
    format: b.brief.recommended_format,
    paa_gaps: b.brief.paa_gaps_to_win.length,
    unique_angles: b.unique_angles.length,
  })),
});

console.log('\n---SETUP_DONE---');
console.log(JSON.stringify({
  status: 'ok',
  briefs: briefs.length,
  perplexityCostUsd: Math.round(costPpx * 10000) / 10000,
  output: path.relative(PROJECT_ROOT, path.join(WORK, 'briefs.json')),
  perBrief: briefs.map((b) => `${b.slug}: ${b.brief.recommended_format}, ${b.brief.paa_gaps_to_win.length} PAA-gaps, ${b.unique_angles.length} angles`),
}, null, 2));

// ---------- helpers ----------
async function writeBriefMd(b) {
  const docsDir = path.join(PROJECT_ROOT, 'docs', 'seo', 'briefs');
  await fsp.mkdir(docsDir, { recursive: true });
  const md = `# Brief — ${b.primary_keyword}

**URL:** \`${b.url_path}\` · **Pillar:** ${b.pillar} · **Intent:** ${b.intent} · **Format:** ${b.brief.recommended_format}
**Target length:** ~${b.brief.word_count_target} words · **Schema:** ${b.brief.schema_type}
**Primary CTA:** ${b.brief.primary_cta} → \`${b.brief.cta_url}\`

_Format rationale:_ ${b.brief.format_rationale}

## H1
${b.brief.h1}

## Table-stakes sections (required coverage — what every ranking page has)
${b.brief.table_stakes_h2.map((h) => `- ${h}`).join('\n') || '_none_'}

## Gaps in the current top results (our opening)
${b.brief.gaps.map((g) => `- ${g}`).join('\n') || '_none_'}

## PAA gaps to win (relevant, under-answered → snippet/AI-citation bait)
${b.brief.paa_gaps_to_win.map((q) => `- ${q}`).join('\n') || '_none flagged_'}

## Unique angles to add (novel vs top-10, cited — verify factual claims)
${b.unique_angles.length
    ? b.unique_angles.map((a) => `- **${a.insight}**\n  - source: ${a.source_url} (${a.source_kind}, confidence ${a.confidence}, ${a.novelty_vs_serp}${a.needs_verification ? ', ⚠ verify' : ''})`).join('\n')
    : '_none — not forced_'}

## FAQ (from People Also Ask)
${b.brief.faq_from_paa.map((f) => `**${f.q}**\n${f.a}`).join('\n\n') || '_none_'}

## SERP snapshot
- Top domains: ${b.serp.top_domains.join(', ')}
- Features: ${Object.entries(b.serp.features).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}
- AI Overview present: ${b.serp.ai_overview.present} · CTR outlook: ${b.serp.ctr_outlook}
- Crawled: ${b.crawled_competitors.filter((c) => c.crawl_status === 'ok').length}/${b.crawled_competitors.length} ok

---
_Raw evidence: SERP \`${b.serp.raw_ref}\`, crawled pages \`pages/${b.slug}/\`, research \`research/${b.slug}.json\` (under \`.supertools-state/${SKILL_ID}/\`)._
`;
  await fsp.writeFile(path.join(docsDir, `${b.slug}.md`), md);
}
