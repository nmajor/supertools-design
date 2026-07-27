#!/usr/bin/env node
// seo-05-internal-links — inject the content-map's internal-link graph INTO the
// built guide pages, so the cluster is interlinked in-content (seo-04's template
// has no related-links slot). Closes the in-content half of the orphan problem
// that the footer + funnel-index pages closed navigationally.
//
// Per page it renders a "Keep planning" section: spoke -> hub (up), hub -> spokes
// (down), 1-3 siblings, and a conversion link to the cluster's real tool (colors
// -> the existing palette tool; else the quiz). Links point ONLY to pages that
// are actually built (filtered against the seo-04 registry), with descriptive
// keyword anchors, capped per playbook §5.3. Grounded in
// docs/research/content-architecture-clusters.md §3 + docs/seo/homepage-hub-linking.md.
//
// Deterministic, offline, idempotent: the injected block is delimited by markers
// so a re-run replaces it rather than stacking. Run AFTER seo-04 builds pages;
// if a page is later rebuilt by seo-04 (which drops the block), re-run this.
//
// Usage: node .skills/seo-05-internal-links/setup.mjs

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../_shared/env.mjs';
import { resolveProjectConfig } from '../_shared/project.mjs';
import { STATE_DIR, writeReceipt } from '../_shared/state.mjs';
import { readUpstream, assertSchema, recordConsumes, printDone, hashObj } from '../_shared/seo.mjs';
import { isCompetitorUrl } from '../_shared/competitors.mjs';

const SKILL_ID = 'seo-05-internal-links';
const MAP = 'seo-01b-content-map';
const PAGES = 'seo-04-page-build';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(STATE_DIR, SKILL_ID);
const cfg = JSON.parse(fs.readFileSync(resolveProjectConfig(HERE, 'config'), 'utf-8'));
const cfgHash = hashObj(cfg);

export const BEGIN = '{/* seo-05:related */}';
export const END = '{/* /seo-05:related */}';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The injected JSX. Plain crawlable <a href> (real hrefs, SSR-rendered), styled
// to the guide's rose link tokens. References the RELATED const injected alongside.
export function relatedSection(heading) {
  return `${BEGIN}
      {RELATED.length > 0 && (
        <section className="mt-14 border-t border-stone-200 pt-6 dark:border-stone-800">
          <h2 className="mb-4 font-serif text-2xl font-semibold text-stone-900 dark:text-stone-100">${heading}</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {RELATED.map((r) => (
              <li key={r.href}>
                <a href={r.href} className="text-rose-900 hover:underline dark:text-rose-300">{r.anchor}</a>
              </li>
            ))}
          </ul>
        </section>
      )}
      ${END}`;
}

function injectRelated(src, related, heading) {
  const constLine = `const RELATED: { href: string; anchor: string }[] = ${JSON.stringify(related)}`;
  // 1. RELATED const (replace if present, else insert before JSON_LD)
  src = /const RELATED:[^\n]*\n/.test(src)
    ? src.replace(/const RELATED:[^\n]*\n/, constLine + '\n')
    : src.replace(/(\nconst JSON_LD = )/, `\n${constLine}$1`);
  // 2. the section (replace marker block if present, else insert after the article)
  const block = relatedSection(heading);
  const markerRe = new RegExp(escRe(BEGIN) + '[\\s\\S]*?' + escRe(END));
  if (markerRe.test(src)) return src.replace(markerRe, block);
  return src.replace(/(dangerouslySetInnerHTML=\{\{ __html: BODY_WITH_CHIPS \}\}\s*\/>)/, `$1\n      ${block}`);
}

// ===== read upstreams =====
const { data: cmap, hash: cmHash } = await readUpstream(MAP, 'content-map.json');
assertSchema(cmap, 'content-map@1');
const { data: reg, hash: regHash } = await readUpstream(PAGES, 'pages.json');
assertSchema(reg, 'compact-pages@1');

// built pages: slug -> { route_path, route_file, anchor(keyword), cluster }
const built = new Map();
for (const p of reg.pages || []) {
  built.set(p.slug, { href: p.route_path, route_file: p.route_file, anchor: p.primary_keyword, cluster: p.cluster || null });
}
// content-map graph + keyword, by slug
const cm = new Map((cmap.pages || []).map((p) => [p.slug, p]));
const builtHubs = (cmap.clusters || [])
  .map((c) => c.hub_slug).filter((s) => s && built.has(s));

const convFor = (clusterId) => cfg.cluster_conversion[clusterId] || cfg.cluster_conversion._default;

// ===== compute + inject per built page =====
const results = [];
for (const [slug, b] of built) {
  const seen = new Set([b.href]); // seed with this page's own href so it can never self-link
  const related = [];
  const push = (href, anchor) => {
    if (!href || !anchor || seen.has(href) || isCompetitorUrl(href)) return;
    seen.add(href);
    related.push({ href, anchor });
  };
  const resolveSlug = (s) => { const t = built.get(s); if (t) push(t.href, t.anchor); };

  const node = cm.get(slug);
  if (node) {
    (node.links?.up || []).forEach(resolveSlug);
    (node.links?.siblings || []).slice(0, 3).forEach(resolveSlug);
    (node.links?.down || []).forEach(resolveSlug);
  } else {
    // not in the content map (e.g. a pre-existing guide): offer the built hubs
    builtHubs.forEach(resolveSlug);
  }
  // always end on a conversion link to the cluster's real tool / the quiz.
  // Cluster comes from the content map (authoritative); the registry may not carry it.
  const conv = convFor(node?.cluster || b.cluster);
  push(conv.href, conv.anchor);

  const capped = related.slice(0, cfg.max_links);
  const file = path.join(PROJECT_ROOT, b.route_file);
  if (!fs.existsSync(file)) { results.push({ slug, status: 'missing-file', links: 0 }); continue; }
  const before = fs.readFileSync(file, 'utf-8');
  const after = injectRelated(before, capped, cfg.section_heading);
  if (after !== before) await fsp.writeFile(file, after);
  results.push({ slug, links: capped.length, targets: capped.map((r) => r.href), status: 'ok' });
}

const totalLinks = results.reduce((s, r) => s + (r.links || 0), 0);
console.log(`[seo-05] injected internal links into ${results.length} page(s); ${totalLinks} links total`);

// ===== artifact + receipt =====
await fsp.mkdir(WORK, { recursive: true });
const artifact = {
  schema_version: 'internal-links@1',
  generated_at: new Date().toISOString(),
  source: { map: MAP, map_hash: cmHash, pages: PAGES, pages_hash: regHash, config_hash: cfgHash },
  page_count: results.length,
  total_links: totalLinks,
  pages: results,
};
await fsp.writeFile(path.join(WORK, 'internal-links.json'), JSON.stringify(artifact, null, 2));

await writeReceipt(SKILL_ID, { pages: results.length, total_links: totalLinks }, {
  provides: ['internal-links'],
  config_hash: cfgHash,
  consumes: recordConsumes([
    { producerId: MAP, file: 'content-map.json', hash: cmHash },
    { producerId: PAGES, file: 'pages.json', hash: regHash },
  ]),
  data: path.relative(PROJECT_ROOT, path.join(WORK, 'internal-links.json')),
});

printDone({ pages: results.length, total_links: totalLinks, per_page: results.map((r) => `${r.slug}:${r.links}`) });
