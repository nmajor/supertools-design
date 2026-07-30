#!/usr/bin/env node
// 11-legal-pages setup.
// Render /terms, /privacy, /refund from token templates with the project's
// legal facts. Fails loudly if any {{TOKEN}} is left unresolved.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(SKILL_DIR, 'templates');
const STATE_SUB = path.join(PROJECT_ROOT, '.supertools-state', '11-legal-pages');
// The legal pages belong INSIDE the marketing layout: src/routes/_marketing/
// is what wraps children in MarketingNav + Footer, so writing them at the
// route root produced pages with no header or footer AND duplicate "/terms"
// and "/privacy" paths that broke router generation outright. The scaffold's
// 50-legal step already ships _marketing/terms.tsx and _marketing/privacy.tsx
// carrying {{KEY}} placeholders that render VERBATIM in a live site; these
// files replace them, which is what that step's own comment says a later
// supertools-design step should do.
const ROUTES = path.join(PROJECT_ROOT, 'src', 'routes', '_marketing');

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

// Per-project legal copy.
//
// These templates carry NO product description of their own. An earlier version
// hardcoded one project's prose — "turns a short visual quiz into a one-time
// pack of AI-generated, wedding-aesthetic image artifacts", a Base/Premium
// price, and a Pinterest licence grant — into EVERY project's Terms of Service.
// That is a legally-operative document describing the wrong product, wrong
// commercial model and wrong licence. There is no default and no fallback: a
// project without a config halts here rather than shipping invented terms.
function legalCopyTokens(projectName) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const own = path.join(here, `config.${projectName}.json`);
  let cfg;
  try {
    cfg = JSON.parse(fsSync.readFileSync(own, 'utf-8'));
  } catch (e) {
    die(
      `No legal copy for this project. Expected ${own}.\n` +
      'Copy config.example.json to that path and fill it in — product summary, what data you ' +
      'collect, your pricing posture, and the licence you grant.\n' +
      'This skill deliberately has no default: shipping another project\'s Terms of Service ' +
      'under your brand is worse than shipping none.',
    );
  }

  const required = ['productSummary', 'dataItems', 'pricingClause', 'licenseClause', 'refundSummary'];
  const missing = required.filter((k) => !cfg[k] || (Array.isArray(cfg[k]) && !cfg[k].length));
  if (missing.length) die(`${own} is missing: ${missing.join(', ')}`);
  if (!Array.isArray(cfg.dataItems)) die(`${own}: dataItems must be an array of <li> inner HTML strings`);

  // Rendered prominently when the product handles microphones, cameras, screen
  // capture, location, health or financial data. Omitted entirely otherwise —
  // an empty callout is worse than none.
  const sensitive = cfg.sensitiveDataNote
    ? `
        <div className="not-prose my-6 rounded-lg border-l-4 border-amber-500 border-y border-r border-amber-200 bg-amber-50/60 px-4 py-3 dark:border-amber-900/60 dark:border-l-amber-500 dark:bg-amber-950/20">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">What these recordings can contain</p>
          <p className="mt-1 text-sm text-amber-800/90 dark:text-amber-200/80">${cfg.sensitiveDataNote}</p>
        </div>
`
    : '';

  return {
    PRODUCT_SUMMARY: cfg.productSummary,
    DATA_ITEMS: cfg.dataItems.map((li) => `          <li>${li}</li>`).join('\n'),
    PRICING_CLAUSE: cfg.pricingClause,
    LICENSE_CLAUSE: cfg.licenseClause,
    REFUND_SUMMARY: cfg.refundSummary,
    SENSITIVE_DATA_BLOCK: sensitive,
  };
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
    ...legalCopyTokens(project.projectName),
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
  // TanStack Router types its route paths from a generated tree. Adding route
  // FILES without regenerating it leaves `createFileRoute('/terms')` failing
  // TS2345 ("not assignable to keyof FileRoutesByPath") and the build broken —
  // the pages exist but the app does not compile.
  {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('npm', ['run', 'generate-routes'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    if (r.status !== 0) {
      die('npm run generate-routes failed after writing the legal routes:\n' +
          (r.stderr || r.stdout || '').slice(-800));
    }
    console.log('  regenerated the router tree');
  }

  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
