#!/usr/bin/env node
// 17-launch-verify setup — live end-to-end smoke of the production domain.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { requireDomain, readProject } from '../_shared/project.mjs';

const STATE = path.join(PROJECT_ROOT, '.supertools-state', '17-launch-verify');
const DOMAIN = requireDomain();
const WWW = `https://www.${DOMAIN}`;
const APEX = `https://${DOMAIN}`;
// Uptime check slug written by skill 13-uptime.
// Public routes smoke-tested for a 200. Override with LAUNCH_ROUTES
// (comma-separated) for a project with a different page set.
const ROUTES = (process.env.LAUNCH_ROUTES || '/,/terms,/privacy,/refund,/contact,/privacy-request')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Path used to prove the apex->www 301 preserves path+query.
const PROBE_PATH = process.env.LAUNCH_PROBE_PATH || '/';

const HEARTBEAT = `${readProject().projectName}-prod-heartbeat`;
const checks = [];
const add = (name, ok, hard, detail = '') => { checks.push({ name, ok, hard, detail }); console.log(`[${ok ? 'OK ' : (hard ? 'FAIL' : 'warn')}] ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readVenue() {
  try {
    const t = await fs.readFile(path.join(PROJECT_ROOT, 'src/generation/schemas.ts'), 'utf-8');
    const m = t.match(/QUIZ_VENUE_IDS\s*=\s*\[([\s\S]*?)\]/);
    // Surface contract drift instead of silently falling back — an empty venue
    // makes the generation check fail loudly (the schema would 400 it).
    return m ? ((m[1].match(/"([a-z][a-z-]+)"/) || [])[1] || '') : '';
  } catch { return ''; }
}

async function main() {
  loadEnv();
  await fs.mkdir(STATE, { recursive: true });

  // --- HARD: apex → www 301 preserving path + query ---
  try {
    const r = await fetch(`${APEX}${PROBE_PATH}?x=1`, { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    add('apex→www 301 (path+query preserved)', r.status === 301 && loc === `${WWW}${PROBE_PATH}?x=1`, true, `${r.status} → ${loc}`);
  } catch (e) { add('apex→www 301 (path+query preserved)', false, true, e.message); }

  // --- HARD: pages render ---
  for (const p of ROUTES) {
    try { const r = await fetch(`${WWW}${p}`); add(`GET ${p} → 200`, r.ok, true, `HTTP ${r.status}`); }
    catch (e) { add(`GET ${p} → 200`, false, true, e.message); }
  }

  // --- HARD: /api/health ---
  try { const r = await fetch(`${WWW}/api/health`); const j = await r.json().catch(() => ({})); add('/api/health {ok:true}', r.ok && j.ok === true, true, `HTTP ${r.status}`); }
  catch (e) { add('/api/health {ok:true}', false, true, e.message); }

  // --- HARD: home HTML has OG + favicon + analytics ---
  try {
    const html = await (await fetch(`${WWW}/`)).text();
    add('home: OG meta present', /og:title|og:image|property="og:/.test(html), true);
    add('home: favicon link present', /rel="icon"|favicon/.test(html), true);
    add('home: analytics script present', /rybbit|data-site-id/i.test(html), true);
  } catch (e) { add('home HTML head', false, true, e.message); }

  // --- VERIFIED: contact → Chatwoot pipeline ---
  try {
    const r = await fetch(`${WWW}/api/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Launch Verify', email: `launch-verify@${DOMAIN}`, subject: 'launch smoke', message: 'Automated launch-verify smoke from skill 17.' }) });
    add('POST /api/contact → 2xx (Chatwoot)', r.ok, false, `HTTP ${r.status}`);
  } catch (e) { add('POST /api/contact → 2xx (Chatwoot)', false, false, e.message); }

  // --- VERIFIED (hard): REAL directions generation against live OpenAI + fal.ai ---
  let genSid = '', genCookie = '', genOk = false, genDetail = '', genDirs = 0;
  try {
    const venue = await readVenue();
    const submission = { selectedInspirationIds: ['tile-01', 'tile-02', 'tile-03'], season: 'fall', venue, guestCount: '30-100', selectedPaletteHexes: [], elapsedSec: 6 };
    const jar = [];
    const r = await fetch(`${WWW}/api/directions/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ submission }) });
    const setc = r.headers.get('set-cookie'); if (setc) jar.push(setc.split(';')[0]);
    const body = await r.json().catch(() => ({}));
    const sid = body.quizSessionId || body.sessionId || body.id || body.quizSession?.id;
    genSid = sid || ''; genCookie = jar.join('; ');
    if (!r.ok || !sid) { genDetail = `create HTTP ${r.status} ${JSON.stringify(body).slice(0, 140)}`; }
    else {
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline) {
        await sleep(5000);
        const sr = await fetch(`${WWW}/api/status/directions/${sid}`, { headers: genCookie ? { cookie: genCookie } : {} });
        const sj = await sr.json().catch(() => ({}));
        const state = sj.genState || sj.status || sj.state;
        const dirs = sj.directions || sj.results || [];
        if (state === 'error' || state === 'failed') { genDetail = `gen ${state}: ${JSON.stringify(sj).slice(0, 140)}`; break; }
        if (Array.isArray(dirs) && dirs.length > genDirs) genDirs = dirs.length;
        // Require the full set of 3 directions the product promises — not just a
        // "ready" state or a single direction.
        if (genDirs >= 3) { genOk = true; genDetail = `state=${state} dirs=${genDirs} sid=${sid}`; break; }
      }
      if (!genOk && !genDetail) genDetail = `incomplete (state=ready? dirs=${genDirs}/3) sid=${sid}`;
    }
  } catch (e) { genDetail = e.message; }
  add('REAL directions generation (live OpenAI+fal)', genOk, true, genDetail);

  // --- VERIFIED: Polar sandbox checkout opens (realistic pay-then-pick: reuse the quiz session) ---
  try {
    const r = await fetch(`${WWW}/api/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(genCookie ? { cookie: genCookie } : {}) }, body: JSON.stringify({ tier: 'base', quizSessionId: genSid }) });
    const txt = await r.text(); let url = '';
    try { url = (JSON.parse(txt).url) || ''; } catch {} if (!url) { const m = txt.match(/https?:\/\/[^"'\s]*polar[^"'\s]*/i); url = m ? m[0] : ''; }
    add('POST /api/checkout → Polar SANDBOX URL', r.ok && /^https:\/\/sandbox\.polar\.sh\//.test(url), false, url ? url.slice(0, 70) : `HTTP ${r.status} ${txt.slice(0, 80)}`);
  } catch (e) { add('POST /api/checkout → Polar sandbox URL', false, false, e.message); }

  // --- VERIFIED: cron heartbeat recent ---
  try {
    const host = (process.env.HEALTHCHECK_HOST || '').replace(/\/+$/, '');
    const r = await fetch(`${host}/api/v3/checks/`, { headers: { 'X-Api-Key': process.env.HEALTHCHECK_API_KEY } });
    const j = await r.json().catch(() => ({}));
    const c = (j.checks || []).find((x) => x.slug === HEARTBEAT || x.name === HEARTBEAT);
    const recent = c && c.last_ping && (Date.now() - new Date(c.last_ping).getTime() < 2 * 3600 * 1000);
    add('cron heartbeat recent (Healthchecks)', !!recent, false, c ? `last_ping=${c.last_ping} status=${c.status}` : 'check not found');
  } catch (e) { add('cron heartbeat recent (Healthchecks)', false, false, e.message); }

  // Every check the launch receipt claims must pass — hard AND verified.
  const fails = checks.filter((c) => !c.ok);
  const report = { domain: DOMAIN, when: new Date().toISOString(), checks, directionsCount: genDirs,
    hardPassed: checks.filter((c) => c.hard && c.ok).length, hardTotal: checks.filter((c) => c.hard).length,
    verifiedPassed: checks.filter((c) => !c.hard && c.ok).length, verifiedTotal: checks.filter((c) => !c.hard).length };
  await fs.writeFile(path.join(STATE, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed (${report.hardPassed}/${report.hardTotal} hard, ${report.verifiedPassed}/${report.verifiedTotal} verified · ${genDirs} directions)`);
  if (fails.length) { console.error(`\n[launch] checks failed: ${fails.map((c) => c.name).join('; ')}`); process.exit(1); }
  console.log('---SETUP_DONE---');
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
