#!/usr/bin/env node
// Verifier for seo-05-internal-links. Checks:
//   - upstreams (content-map@1, compact-pages@1) readable + not stale
//   - artifact present; every built guide page carries a RELATED const + the
//     marker-delimited section, with >= 1 link
//   - every injected href resolves to a built route / a valid app URL (no 404,
//     no self-link, no competitor link); anchors are descriptive
//   - receipt records both upstream hashes + the config hash
// Exit 0 = pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../_shared/env.mjs';
import { resolveProjectConfig } from '../_shared/project.mjs';
import { STATE_DIR } from '../_shared/state.mjs';
import { readUpstream, assertSchema, staleAgainst, hashObj } from '../_shared/seo.mjs';
import { isCompetitorUrl } from '../_shared/competitors.mjs';

const SKILL_ID = 'seo-05-internal-links';
const MAP = 'seo-01b-content-map';
const PAGES = 'seo-04-page-build';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(resolveProjectConfig(HERE, 'config'), 'utf-8'));
const cfgHash = hashObj(cfg);

let failed = 0;
const ok = (m) => console.log(`[OK ] ${m}`);
const bad = (m) => { console.log(`[FAIL] ${m}`); failed++; };

let builtPaths = new Set();
try {
  const { data: reg, hash } = await readUpstream(PAGES, 'pages.json');
  assertSchema(reg, 'compact-pages@1');
  builtPaths = new Set((reg.pages || []).map((p) => p.route_path));
  ok(`upstream ${PAGES} readable (${builtPaths.size} built pages)`);
  (await staleAgainst(SKILL_ID, PAGES, hash)) === true ? bad(`${PAGES} changed since last run — re-run setup.mjs`) : ok(`${PAGES} unchanged since last run`);
} catch (e) { bad(`upstream ${PAGES}: ${e.message}`); }
try {
  const { data, hash } = await readUpstream(MAP, 'content-map.json');
  assertSchema(data, 'content-map@1');
  ok(`upstream ${MAP} readable`);
  (await staleAgainst(SKILL_ID, MAP, hash)) === true ? bad(`${MAP} changed since last run — re-run setup.mjs`) : ok(`${MAP} unchanged since last run`);
} catch (e) { bad(`upstream ${MAP}: ${e.message}`); }

const artPath = path.join(STATE_DIR, SKILL_ID, 'internal-links.json');
if (!fs.existsSync(artPath)) { bad(`artifact absent — run setup.mjs`); console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
const a = JSON.parse(fs.readFileSync(artPath, 'utf-8'));
try { assertSchema(a, 'internal-links@1'); ok('internal-links.json is internal-links@1'); } catch (e) { bad(e.message); }

// valid link targets = built route paths + the configured conversion hrefs.
const validHrefs = new Set([...builtPaths, ...Object.values(cfg.cluster_conversion).map((c) => c.href)]);

let pagesWithLinks = 0;
for (const p of a.pages || []) {
  const entry = (a.source && p.targets) ? p : null;
  // re-read the actual route file to assert the injection landed
  const reg = JSON.parse(fs.readFileSync(path.join(STATE_DIR, PAGES, 'pages.json'), 'utf-8'));
  const rec = (reg.pages || []).find((x) => x.slug === p.slug);
  if (!rec) { bad(`${p.slug}: not in page registry`); continue; }
  const src = fs.readFileSync(path.join(PROJECT_ROOT, rec.route_file), 'utf-8');
  const hasConst = /const RELATED:[^\n]*=\s*\[/.test(src);
  const hasSection = src.includes('{/* seo-05:related */}') && src.includes('{/* /seo-05:related */}');
  hasConst && hasSection ? ok(`${p.slug}: related const + section injected (${p.links} links)`) : bad(`${p.slug}: missing RELATED const/section`);
  if (p.links > 0) pagesWithLinks++;
  // every target href valid, not self, not competitor
  const selfHref = rec.route_path;
  for (const href of p.targets || []) {
    if (href === selfHref) bad(`${p.slug}: self-link ${href}`);
    else if (isCompetitorUrl(href)) bad(`${p.slug}: competitor link ${href}`);
    else if (!validHrefs.has(href)) bad(`${p.slug}: dangling link ${href} (not a built route)`);
  }
}
pagesWithLinks === (a.pages || []).length ? ok(`all ${pagesWithLinks} pages have >=1 internal link`) : bad(`${(a.pages || []).length - pagesWithLinks} page(s) with 0 links`);

const recPath = path.join(STATE_DIR, `${SKILL_ID}.json`);
if (fs.existsSync(recPath)) {
  const r = JSON.parse(fs.readFileSync(recPath, 'utf-8'));
  const has = (id) => (r.consumes || []).some((x) => x.producerId === id && x.hash);
  has(MAP) && has(PAGES) ? ok('receipt records both upstream hashes') : bad('receipt missing a consumes hash');
  r.config_hash === cfgHash ? ok('receipt records current config hash') : bad('receipt config hash missing/stale');
  (r.provides || []).includes('internal-links') ? ok('receipt provides internal-links') : bad('receipt missing provides');
} else bad('receipt missing');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
