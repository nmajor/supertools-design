#!/usr/bin/env node
// 10-analytics setup.
// Resolve Rybbit site_id for the domain, embed the tracking script in
// __root.tsx, and write the event-taxonomy module.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, requireEnv, writeEnvVar, PROJECT_ROOT } from '../_shared/env.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '10-analytics');
const ROOT_TSX = path.join(PROJECT_ROOT, 'src', 'routes', '__root.tsx');
const MARKER = 'supertools-analytics';

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

function rybbitBase() { return (process.env.RYBBIT_HOST || '').replace(/\/+$/, ''); }

async function rybbit(pathSuffix, opts = {}) {
  const r = await fetch(`${rybbitBase()}${pathSuffix}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.RYBBIT_API_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

const siteIdOf = (s) => String(s.siteId ?? s.site_id ?? s.id);

async function findSite(orgId, domain) {
  const res = await rybbit(`/api/organizations/${orgId}/sites`);
  const sites = res.body?.sites || res.body?.data || [];
  return sites.find((s) => String(s.domain || '').toLowerCase() === domain.toLowerCase()) || null;
}

// Resolve the numeric Rybbit site id for the domain, CREATING the site if it
// doesn't exist. Creation uses the org-admin route
// POST /api/organizations/{org}/sites — the rb_ key authenticates on it.
async function resolveSiteId(domain, brand) {
  const orgs = await rybbit('/api/organizations');
  if (!orgs.ok || !Array.isArray(orgs.body) || !orgs.body.length) {
    die(`Rybbit: could not list organizations (${orgs.status}): ${JSON.stringify(orgs.body).slice(0, 160)}`);
  }
  for (const org of orgs.body) {
    const existing = await findSite(org.id, domain);
    if (existing) {
      const id = siteIdOf(existing);
      log(`[rybbit] found existing site ${id} for ${domain} (org ${org.name})`);
      return id;
    }
  }
  const org = orgs.body[0];
  log(`[rybbit] creating site for ${domain} in org ${org.name}...`);
  const created = await rybbit(`/api/organizations/${org.id}/sites`, {
    method: 'POST',
    body: JSON.stringify({ domain, name: brand, trackOutbound: true, webVitals: true, blockBots: true }),
  });
  if (!created.ok) die(`Rybbit create site failed (${created.status}): ${JSON.stringify(created.body).slice(0, 220)}`);
  const id = siteIdOf(created.body);
  log(`[rybbit] created site ${id} for ${domain}`);
  return id;
}

async function resolveBrand() {
  try {
    const md = await fs.readFile(path.join(PROJECT_ROOT, 'CLAUDE.md'), 'utf-8');
    const m = md.match(/Brand:\s*`([^`]+)`/);
    if (m) return m[1];
  } catch {}
  return path.basename(PROJECT_ROOT);
}

async function injectScript(siteId) {
  let src = await fs.readFile(ROOT_TSX, 'utf-8');
  const scriptUrl = `${rybbitBase()}/api/script.js`;
  const tag = `        {/* ${MARKER} */}\n        <script src="${scriptUrl}" data-site-id="${siteId}" defer />`;

  // Idempotent: replace an existing marker block, else insert after <HeadContent />.
  const markerRe = new RegExp(`\\s*\\{/\\* ${MARKER} \\*/\\}\\s*\\n\\s*<script[^>]*/>`, 'm');
  if (markerRe.test(src)) {
    src = src.replace(markerRe, `\n${tag}`);
    log('  replaced existing analytics script tag');
  } else {
    if (!/<HeadContent \/>/.test(src)) die('Could not find <HeadContent /> in __root.tsx to inject after.');
    src = src.replace(/(<HeadContent \/>)/, `$1\n${tag}`);
    log('  injected analytics script tag after <HeadContent />');
  }
  await fs.writeFile(ROOT_TSX, src);
}

async function main() {
  loadEnv();
  requireEnv(['RYBBIT_HOST', 'RYBBIT_API_KEY']);
  await fs.mkdir(STATE_SUB, { recursive: true });

  const project = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8'));
  const domain = project.domain;
  const brand = await resolveBrand();

  const siteId = await resolveSiteId(domain, brand);
  await writeEnvVar('RYBBIT_SITE_ID', siteId);

  await injectScript(siteId);

  await fs.mkdir(path.join(PROJECT_ROOT, 'src', 'lib'), { recursive: true });
  await fs.copyFile(path.join(SKILL_DIR, 'templates', 'analytics.ts'), path.join(PROJECT_ROOT, 'src', 'lib', 'analytics.ts'));
  log('  wrote src/lib/analytics.ts (event taxonomy + track())');

  const summary = {
    domain, siteId, rybbitHost: rybbitBase(),
    scriptUrl: `${rybbitBase()}/api/script.js`,
    files: ['src/routes/__root.tsx (analytics script injected)', 'src/lib/analytics.ts'],
    envWritten: ['RYBBIT_SITE_ID'],
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(STATE_SUB, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
