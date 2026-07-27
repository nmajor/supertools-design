#!/usr/bin/env node
// Verifier for seo-03-page-images. Substantive checks:
//   - deps present (FAL + OpenAI); upstream page-briefs readable
//   - images.json is page-images@1 with >=1 item
//   - every referenced WebP exists on disk, is non-trivial, has alt + dimensions
//   - provenance recorded; receipt records the upstream hash
// Exit 0 = pass.

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, loadEnv } from '../_shared/env.mjs';
import { STATE_DIR } from '../_shared/state.mjs';
import { readUpstream, assertSchema, staleAgainst } from '../_shared/seo.mjs';
import { falConfigured } from '../_shared/fal.mjs';

const SKILL_ID = 'seo-03-page-images';
const UPSTREAM = 'seo-02-serp-briefs';
loadEnv();

let failed = 0;
const ok = (m) => console.log(`[OK ] ${m}`);
const bad = (m) => { console.log(`[FAIL] ${m}`); failed++; };

falConfigured() ? ok('FAL_API_KEY set') : bad('FAL_API_KEY missing');
process.env.OPENAI_API_KEY ? ok('OPENAI_API_KEY set') : bad('OPENAI_API_KEY missing');

try {
  const { data, hash } = await readUpstream(UPSTREAM, 'briefs.json');
  assertSchema(data, 'page-briefs@1');
  ok(`upstream ${UPSTREAM} readable`);
  if (await staleAgainst(SKILL_ID, UPSTREAM, hash)) console.log(`[INFO] upstream ${UPSTREAM} changed since last run — re-run setup.mjs to refresh.`);
} catch (e) { bad(`upstream: ${e.message}`); }

const dataPath = path.join(STATE_DIR, SKILL_ID, 'images.json');
if (!fs.existsSync(dataPath)) {
  console.log(`[INFO] no run yet (${path.relative(PROJECT_ROOT, dataPath)} absent) — run setup.mjs first.`);
} else {
  const art = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  try { assertSchema(art, 'page-images@1'); ok('images.json is page-images@1'); } catch (e) { bad(e.message); }
  art.provenance?.iptc_digital_source_type === 'trainedAlgorithmicMedia'
    ? ok('AI provenance recorded') : bad('provenance missing');
  const items = art.items || [];
  items.length ? ok(`${items.length} page(s) with images`) : bad('no image items');
  for (const it of items) {
    const imgs = it.images || [];
    imgs.length >= 1 ? ok(`${it.slug}: ${imgs.length} images`) : bad(`${it.slug}: no images`);
    for (const im of imgs) {
      // src is a public URL path (/img/...); on disk it lives under public/.
      const fp = path.join(PROJECT_ROOT, 'public', im.src.replace(/^\//, ''));
      if (!fs.existsSync(fp)) { bad(`${it.slug}: missing file ${im.src}`); continue; }
      const sz = fs.statSync(fp).size;
      const okFile = sz > 3000 && im.width > 200 && im.height > 200 && im.alt && im.alt.length > 15;
      okFile ? ok(`${it.slug}/${im.role}: ${im.width}x${im.height} ${(sz / 1024).toFixed(0)}KB, alt ok`)
             : bad(`${it.slug}/${im.role}: weak (size ${sz}, ${im.width}x${im.height}, alt "${im.alt}")`);
    }
  }
  const rec = path.join(STATE_DIR, `${SKILL_ID}.json`);
  if (fs.existsSync(rec)) {
    const r = JSON.parse(fs.readFileSync(rec, 'utf-8'));
    (r.consumes || []).some((x) => x.producerId === UPSTREAM && x.hash) ? ok('receipt records upstream hash') : bad('receipt missing consumes hash');
  } else bad('receipt missing');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
