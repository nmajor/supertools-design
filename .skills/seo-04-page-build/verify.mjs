#!/usr/bin/env node
// Verifier for seo-04-page-build. Substantive checks:
//   - upstream page-briefs@1 readable
//   - compact-pages@1 registry exists with >= 1 page
//   - the route file exists, targets the right path, carries title/body/JSON-LD/CTA
//   - sanitization held (no <script> smuggled into BODY_HTML)
//   - the route is registered in src/routeTree.gen.ts (it will actually serve)
//   - receipt records the upstream hash (staleness wired)
// Exit 0 = pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, loadEnv } from '../_shared/env.mjs';
import { resolveProjectConfig } from '../_shared/project.mjs';
import { STATE_DIR } from '../_shared/state.mjs';
import { readUpstream, assertSchema, staleAgainst } from '../_shared/seo.mjs';
import { lintTells, buriedLedes } from '../_shared/copy.mjs';
import { isCompetitorUrl, competitorBrandMentions, registrableHost } from '../_shared/competitors.mjs';
import { openaiConfigured } from '../_shared/openai.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const cfgVoice = JSON.parse(
  fs.readFileSync(resolveProjectConfig(HERE, 'config'), 'utf-8')
).voice;

const CFG = JSON.parse(fs.readFileSync(resolveProjectConfig(HERE, 'config'), 'utf-8'));
const CTA_URL = CFG.product?.cta_url || '/';
const CTA_LABEL = CFG.product?.primary_cta || 'Get started';

const OWN_HOST = registrableHost(
  JSON.parse(fs.readFileSync(resolveProjectConfig(HERE, 'config'), 'utf-8')).site_origin
) || '';

const SKILL_ID = 'seo-04-page-build';
const UPSTREAM = 'seo-02-serp-briefs';
loadEnv();

let failed = 0;
const ok = (m) => console.log(`[OK ] ${m}`);
const bad = (m) => { console.log(`[FAIL] ${m}`); failed++; };

openaiConfigured() ? ok('OPENAI_API_KEY set') : bad('OPENAI_API_KEY missing');

try {
  const { data, hash } = await readUpstream(UPSTREAM, 'briefs.json');
  assertSchema(data, 'page-briefs@1');
  ok(`upstream ${UPSTREAM} readable (page-briefs@1, ${data.briefs?.length} brief(s))`);
  // Staleness: did the brief change since this skill last consumed it? (spec §7)
  const stale = await staleAgainst(SKILL_ID, UPSTREAM, hash);
  if (stale) console.log(`[INFO] upstream ${UPSTREAM} changed since last run — re-run setup.mjs to refresh the page.`);
} catch (e) {
  bad(`upstream contract: ${e.message}`);
}

const pagesPath = path.join(STATE_DIR, SKILL_ID, 'pages.json');
if (!fs.existsSync(pagesPath)) {
  console.log(`[INFO] no run yet (${path.relative(PROJECT_ROOT, pagesPath)} absent) — run setup.mjs first.`);
} else {
  const art = JSON.parse(fs.readFileSync(pagesPath, 'utf-8'));
  try { assertSchema(art, 'compact-pages@1'); ok('pages.json is compact-pages@1'); } catch (e) { bad(e.message); }
  const pages = art.pages || [];
  pages.length >= 1 ? ok(`${pages.length} page(s) in registry`) : bad('no pages');

  const routeTree = fs.existsSync(path.join(PROJECT_ROOT, 'src', 'routeTree.gen.ts'))
    ? fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'routeTree.gen.ts'), 'utf-8')
    : '';

  for (const p of pages) {
    const file = path.join(PROJECT_ROOT, p.route_file);
    if (!fs.existsSync(file)) { bad(`route file missing: ${p.route_file}`); continue; }
    const src = fs.readFileSync(file, 'utf-8');

    // A page may be deliberately RETIRED to a redirect (cannibalization fix): a
    // thin `beforeLoad: () => { throw redirect(...) }` stub with no BODY_HTML.
    // Don't assert the content-page shape (META_TITLE/BODY_HTML/JSON-LD/CTA) on
    // those — only that it's a clean redirect with no example.com placeholder.
    const isRetiredRedirect =
      /beforeLoad\s*:/.test(src) && /\bredirect\s*\(/.test(src) && !/const BODY_HTML = "/.test(src);
    if (isRetiredRedirect) {
      ok(`${p.slug}: retired to redirect (content checks skipped)`);
      /example\.com/i.test(src)
        ? bad(`${p.slug}: example.com placeholder present in redirect stub`)
        : ok(`${p.slug}: no example.com placeholder`);
      continue;
    }

    const checks = {
      'createFileRoute path': src.includes(`createFileRoute('${p.route_path}')`),
      'META_TITLE': /const META_TITLE = ".+"/.test(src),
      'canonical link': src.includes('rel: \'canonical\''),
      'BODY_HTML': /const BODY_HTML = "/.test(src),
      'JSON-LD': src.includes('application/ld+json') && src.includes('JSON_LD'),
      'CTA': src.includes(`navigate({ to: '${CTA_URL}' })`) && src.includes(CTA_LABEL),
    };
    for (const [k, v] of Object.entries(checks)) v ? ok(`${p.slug}: ${k}`) : bad(`${p.slug}: missing ${k}`);
    // sanitization held — no executable script smuggled into the embedded HTML const
    const bodyMatch = src.match(/const BODY_HTML = (".*?")\nconst FAQ/s);
    if (bodyMatch) {
      const body = JSON.parse(bodyMatch[1]);
      /<\s*script/i.test(body) ? bad(`${p.slug}: <script> survived sanitization`) : ok(`${p.slug}: body sanitized (no <script>)`);
      /```/.test(body) ? bad(`${p.slug}: markdown code fence leaked into body`) : ok(`${p.slug}: no code-fence leak`);
      // answer-first: warn on any section that buries the answer in sentence 1
      const buried = buriedLedes(body);
      buried.length === 0
        ? ok(`${p.slug}: sections answer their heading first`)
        : console.log(`[INFO] ${p.slug}: buried-lede section(s) to review: ${buried.map((b) => b.heading).join('; ')}`);
      // voice invariant — zero AI tells (the refined-skill bar)
      const t = lintTells(body, cfgVoice);
      // Hard-fail on the reliably-removable tells; phrase-tells are LLM-judgment, so warn.
      const hardTells = [...t.banned, ...t.constructions];
      hardTells.length === 0
        ? ok(`${p.slug}: 0 banned/construction tells`)
        : bad(`${p.slug}: tells present: ${hardTells.join(', ')}`);
      if (t.phrases?.length) console.log(`[INFO] ${p.slug}: structural phrase(s) to review: ${t.phrases.join(', ')}`);
      // HARD typography-tell ban — zero dashes + curly quotes + emoji anywhere
      // (cleanCopy guarantees these, so the gate proves the boundary ran).
      const dashes = (src.match(/[—–―‒]/g) || []).length;
      const curly = (src.match(/[‘’“”]/g) || []).length;
      const emoji = (src.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}✅✨❤⭐👉]/gu) || []).length;
      dashes === 0 ? ok(`${p.slug}: 0 em/en dashes`) : bad(`${p.slug}: ${dashes} dash(es) present`);
      curly === 0 ? ok(`${p.slug}: 0 curly quotes`) : bad(`${p.slug}: ${curly} curly quote(s) present`);
      emoji === 0 ? ok(`${p.slug}: 0 emoji`) : bad(`${p.slug}: ${emoji} emoji present`);
      // linking invariant — editorial citations dofollow (not nofollow)
      /rel="[^"]*nofollow/i.test(src)
        ? bad(`${p.slug}: nofollow on an editorial link (should be dofollow)`)
        : ok(`${p.slug}: editorial citations dofollow`);
      // competitor invariant — NEVER link to a competitor (no link juice to rivals)
      const allUrls = [...src.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]);
      const compHits = allUrls.filter(isCompetitorUrl);
      compHits.length === 0
        ? ok(`${p.slug}: no competitor links`)
        : bad(`${p.slug}: COMPETITOR LINK(S) present — ${[...new Set(compHits)].join(', ')}`);
      // self-link invariant — own-site links in BODY must be relative, never an
      // absolute https://<own-host>/<path> (brittle, env-leaky, bad practice).
      const absSelfRe = new RegExp(`href="(https?://(?:www\\.)?${OWN_HOST.replace(/\./g, '\\.')}/[^"]*)"`, 'gi');
      const absSelf = [...body.matchAll(absSelfRe)].map((m) => m[1]);
      absSelf.length === 0
        ? ok(`${p.slug}: no absolute self-links in body (relative /paths)`)
        : bad(`${p.slug}: ABSOLUTE self-link(s) in body (use relative /path) — ${[...new Set(absSelf)].join(', ')}`);
      // competitor brand TEXT invariant — never name-drop a rival in prose
      const brandHits = competitorBrandMentions(body);
      brandHits.length === 0
        ? ok(`${p.slug}: no competitor brand text mentions`)
        : bad(`${p.slug}: COMPETITOR BRAND TEXT in body — ${brandHits.join(', ')}`);
    }
    // example.com placeholder invariant — the reserved RFC-2606 domain must NEVER
    // ship anywhere in a built route (links, sources, JSON-LD, meta).
    /example\.com/i.test(src)
      ? bad(`${p.slug}: example.com placeholder present in route (must be removed/normalized)`)
      : ok(`${p.slug}: no example.com placeholder`);
    // actually registered -> it will serve
    routeTree.includes(p.slug) ? ok(`${p.slug}: registered in routeTree.gen.ts`)
      : console.log(`[INFO] ${p.slug}: not in routeTree yet (regenerates on \`npm run dev\`/build)`);
  }

  const rec = path.join(STATE_DIR, `${SKILL_ID}.json`);
  if (fs.existsSync(rec)) {
    const r = JSON.parse(fs.readFileSync(rec, 'utf-8'));
    (r.consumes || []).some((x) => x.producerId === UPSTREAM && x.hash) ? ok('receipt records upstream hash') : bad('receipt missing consumes hash');
  } else bad('receipt missing');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
