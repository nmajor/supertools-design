#!/usr/bin/env node
// 11-legal-pages setup.
// Render /terms, /privacy, /refund from token templates with the project's
// legal facts. Fails loudly if any {{TOKEN}} is left unresolved.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(SKILL_DIR, 'templates');
const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '11-legal-pages');
const ROUTES = path.join(PROJECT_ROOT, 'src', 'routes');

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

async function brand() {
  try {
    const md = await fs.readFile(path.join(PROJECT_ROOT, 'CLAUDE.md'), 'utf-8');
    return md.match(/Brand:\s*`([^`]+)`/)?.[1] || path.basename(PROJECT_ROOT);
  } catch { return path.basename(PROJECT_ROOT); }
}

function todayISO() {
  // Plain node script — Date is fine here (not a workflow runtime).
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  loadEnv();
  await fs.mkdir(STATE_SUB, { recursive: true });

  const project = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8'));
  const domain = project.domain;

  const tokens = {
    BRAND: await brand(),
    DOMAIN: domain,
    LEGAL_ENTITY: process.env.LEGAL_ENTITY || 'NMajor Studios LLC',
    ENTITY_JURISDICTION: process.env.LEGAL_JURISDICTION || 'a Wyoming, USA limited liability company',
    MOR: process.env.MOR_NAME || 'Polar (Polar Software Inc.)',
    PRICE_BASE: process.env.PRICE_BASE || '$19',
    PRICE_PREMIUM: process.env.PRICE_PREMIUM || '$39',
    PRIVACY_EMAIL: `privacy@${domain}`,
    SUPPORT_EMAIL: `support@${domain}`,
    EFFECTIVE_DATE: todayISO(),
  };

  const pages = ['terms', 'privacy', 'refund'];
  const written = [];
  for (const p of pages) {
    let content = await fs.readFile(path.join(TPL, `${p}.tsx.tmpl`), 'utf-8');
    for (const [k, v] of Object.entries(tokens)) {
      content = content.replaceAll(`{{${k}}}`, v);
    }
    const leftover = content.match(/\{\{[A-Z_]+\}\}/g);
    if (leftover) die(`Unresolved token(s) in ${p}.tsx.tmpl: ${[...new Set(leftover)].join(', ')}`);
    const out = path.join(ROUTES, `${p}.tsx`);
    await fs.writeFile(out, content);
    written.push(`src/routes/${p}.tsx`);
    log(`  rendered src/routes/${p}.tsx`);
  }

  const summary = { domain, tokens, pages: written, completedAt: new Date().toISOString() };
  await fs.writeFile(path.join(STATE_SUB, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
