#!/usr/bin/env node
// seo-04-page-build — orchestrator. Reads the brief (+ optional images), runs the
// staged LLM pipeline, cleans the copy at ONE boundary, applies the link policy,
// renders a build-safe TanStack route, and writes the artifact + receipt.
//
// The work lives in sibling modules: pipeline.mjs (LLM chain), links.mjs (link
// policy), jsonld.mjs, template.mjs, voice.mjs (prompts); copy/competitors in
// _shared. See docs/seo/seo-pipeline-spec.md §4.3 (compact-pages@1).
//
// Usage:
//   node .skills/seo-04-page-build/setup.mjs --only "how to make a wedding mood board"
//   node .skills/seo-04-page-build/setup.mjs --slug how-to-make-a-wedding-mood-board

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, loadEnv } from '../_shared/env.mjs';
import { resolveProjectConfig } from '../_shared/project.mjs';
import { STATE_DIR, writeState } from '../_shared/state.mjs';
import {
  readUpstream, assertSchema, slugify, recordConsumes, pickArg, selectBrief, mergeBySlug, printDone,
} from '../_shared/seo.mjs';
import { openaiConfigured, SEO_LLM_MODEL } from '../_shared/openai.mjs';
import { cleanCopy, lintTells, countWords } from '../_shared/copy.mjs';
import { isCompetitorUrl, makeIsOwnUrl, registrableHost, competitorBrandMentions } from '../_shared/competitors.mjs';
import { generateContent } from './pipeline.mjs';
import { processBodyHtml, buildSources } from './links.mjs';
import { buildJsonLd } from './jsonld.mjs';
import { renderRoute, pickImg } from './template.mjs';

const SKILL_ID = 'seo-04-page-build';
const UPSTREAM = 'seo-02-serp-briefs';
const IMAGES = 'seo-03-page-images';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnv();
if (!openaiConfigured()) throw new Error('OPENAI_API_KEY not set (seo-04 content generation).');

const cfg = JSON.parse(fs.readFileSync(resolveProjectConfig(HERE, 'config'), 'utf-8'));
const argv = process.argv.slice(2);
const only = pickArg(argv, '--only');
const slugArg = pickArg(argv, '--slug');
const isOwnUrl = makeIsOwnUrl(cfg.site_origin);
const ownHost = registrableHost(cfg.site_origin);
if (!ownHost) throw new Error('config "site_origin" is missing or not a URL — needed to detect self-links.');
const log = (...a) => console.log('[seo-04]', ...a);

// ---------- upstream brief ----------
const { data: pb, hash: pbHash } = await readUpstream(UPSTREAM, 'briefs.json');
assertSchema(pb, 'page-briefs@1');
const brief = selectBrief(pb.briefs, { only, slug: slugArg });
if (!brief) throw new Error(`No brief matched (only="${only}", slug="${slugArg}"). Available: ${pb.briefs.map((b) => b.slug).join(', ')}`);
const slug = brief.slug || slugify(brief.primary_keyword);
const routePath = `${cfg.route_base}/${slug}`;
// Canonical MUST match where the page actually serves (the route), not the
// content-map's aspirational nested url_path — otherwise the canonical points at
// a 404. The flat-vs-nested URL decision is tracked in docs/seo/homepage-hub-linking.md §7.
const canonical = `${cfg.site_origin}${routePath}`;
log(`building "${brief.primary_keyword}" -> ${routePath}`);

// ---------- optional images from seo-03 (graceful if absent) ----------
let pageImages = [];
let imagesHash = null;
try {
  const im = await readUpstream(IMAGES, 'images.json');
  assertSchema(im.data, 'page-images@1');
  const item = (im.data.items || []).find((it) => it.slug === slug);
  if (item) { pageImages = item.images || []; imagesHash = im.hash; }
} catch { /* images are optional */ }
if (pageImages.length) log(`${pageImages.length} images: ${pageImages.map((i) => i.role).join(', ')}`);

// Never cite a competitor: drop competitor-sourced research angles so the fact +
// its link never enter the prose. (Body strip + sources filter are backstops.)
const beforeAngles = (brief.unique_angles || []).length;
brief.unique_angles = (brief.unique_angles || []).filter((a) => !isCompetitorUrl(a.source_url));
if (brief.unique_angles.length < beforeAngles) log(`dropped ${beforeAngles - brief.unique_angles.length} competitor-sourced angle(s)`);

// ---------- generate ----------
const { content, plan, target } = await generateContent({ brief, cfg, log });

// ---------- ONE clean boundary: every user-facing string + image text ----------
cleanContent(content, pageImages);

// ---------- link policy + sources ----------
// processBodyHtml strips example.com links, drops competitor links, and rewrites
// absolute https://<own-host>/<path> self-links to relative /<path>.
const bodyHtml = processBodyHtml(content.body_html, { isOwnUrl, ownHost });
content.sources = buildSources({
  bodyHtml,
  angleUrls: (brief.unique_angles || []).map((a) => a.source_url).filter(Boolean),
  metaSources: content.sources,
  isOwnUrl,
  clean: cleanCopy,
});

// Competitor brand TEXT mentions can survive the link strip (the LLM name-drops
// "Canva"/"Adobe Color" without a link). We can't safely auto-rewrite prose, so
// surface them loudly here; the verify gate hard-fails on any that ship.
const brandHits = competitorBrandMentions(bodyHtml);
if (brandHits.length) log(`⚠ competitor brand TEXT mention(s) in body: ${brandHits.join(', ')} — remove before launch (verify will fail)`);

// ---------- render the route ----------
const jsonLd = buildJsonLd({ brief, content, canonical, org: cfg.org, images: pageImages, siteOrigin: cfg.site_origin });
const tsx = renderRoute({
  ctaLabel: cfg.product?.primary_cta || 'Get started',
  ctaUrl: cfg.product?.cta_url || '/',
  eyebrow: cfg.page_eyebrow || 'Guide',
  slug, routePath, canonical, skillId: SKILL_ID, model: SEO_LLM_MODEL,
  content, hero: pickImg(pageImages[0]), inlineImgs: pageImages.slice(1).map(pickImg), bodyHtml, jsonLd,
});
const routesDir = path.join(PROJECT_ROOT, cfg.routes_dir);
await fsp.mkdir(routesDir, { recursive: true });
const routeFile = path.join(routesDir, `${slug}.tsx`);
await fsp.writeFile(routeFile, tsx);
log(`wrote ${path.relative(PROJECT_ROOT, routeFile)}`);

// ---------- report ----------
const wordCount = countWords(bodyHtml);
const tells = lintTells(bodyHtml, cfg.voice);
if (wordCount < (target || 1500) * 0.6) log(`⚠ ${wordCount}w is thin vs the SERP median (~${target}w); the ranking pages go deeper, consider re-running.`);
log(`done: ${wordCount} words, ${content.faq?.length || 0} FAQ, ${content.how_to_steps?.length || 0} steps | tells: ${tells.banned.length} banned, ${tells.constructions.length} constructions, ${tells.phrases.length} phrases`);

// ---------- artifact + receipt ----------
const WORK = path.join(STATE_DIR, SKILL_ID);
await fsp.mkdir(WORK, { recursive: true });
const pageEntry = {
  slug, url_path: brief.url_path, route_path: routePath,
  route_file: path.relative(PROJECT_ROOT, routeFile),
  primary_keyword: brief.primary_keyword, schema_type: brief.brief.schema_type, canonical,
  meta_title: content.meta_title, word_count: wordCount, status: 'generated', sitemap: true,
};
const pages = await mergeBySlug(path.join(WORK, 'pages.json'), 'pages', pageEntry);
await fsp.writeFile(
  path.join(WORK, 'pages.json'),
  JSON.stringify({ schema_version: 'compact-pages@1', generated_at: new Date().toISOString(), source: { skill: UPSTREAM, artifact_hash: pbHash }, pages }, null, 2)
);
await fsp.writeFile(path.join(WORK, `content-${slug}.json`), JSON.stringify({ plan, tells, ...content }, null, 2));
await writeState(SKILL_ID, {
  status: 'ok', version: '0.1', timestamp: new Date().toISOString(),
  summary: `Generated compact page "${slug}" (${wordCount} words).`,
  provides: ['compact-pages'],
  consumes: recordConsumes([
    { producerId: UPSTREAM, artifact: 'page-briefs', hash: pbHash },
    ...(imagesHash ? [{ producerId: IMAGES, artifact: 'page-images', hash: imagesHash }] : []),
  ]),
  pageCount: pages.length, lastPage: pageEntry,
});
printDone({
  status: 'ok', slug, route_path: routePath, route_file: pageEntry.route_file,
  word_count: wordCount, schema: brief.brief.schema_type, faq: (content.faq || []).length,
  preview: `npm run dev  then open  http://localhost:3000${brief.url_path}`,
});

// The single clean boundary: cleanCopy every user-facing string + image text, in
// one place, so the "every shipped string is normalized" guarantee is auditable.
function cleanContent(c, images) {
  for (const k of ['body_html', 'meta_title', 'meta_description', 'h1', 'lede', 'closing_cta_heading', 'closing_cta_text']) {
    if (typeof c[k] === 'string') c[k] = cleanCopy(c[k]);
  }
  c.faq = (c.faq || []).map((f) => ({ q: cleanCopy(f.q || ''), a: cleanCopy(f.a || '') }));
  c.how_to_steps = (c.how_to_steps || []).map((s) => ({ name: cleanCopy(s.name || ''), text: cleanCopy(s.text || '') }));
  for (const im of images) { im.alt = cleanCopy(im.alt || ''); im.caption = cleanCopy(im.caption || ''); }
}
