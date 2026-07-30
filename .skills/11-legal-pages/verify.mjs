#!/usr/bin/env node
// 11-legal-pages verifier.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };

// Does this project sell anything? Read from the same per-project legal config
// that drives the copy, so the gate and the pages cannot disagree.
function projectSells(projectName) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    const cfg = JSON.parse(fsSync.readFileSync(path.join(here, `config.${projectName}.json`), 'utf-8'));
    return cfg.sellsProduct === true;
  } catch { return false; }
}

async function main() {
  loadEnv();
  const project = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8'));
  const SELLS = projectSells(project.projectName);
  const domain = project.domain;

  const pages = {
    // Commerce phrases are asserted ONLY when the project actually sells
    // something. Requiring "Merchant of Record" and a "14"-day window
    // unconditionally baked one project's commercial model into every
    // project's gate — a product that sells nothing yet was failed for
    // correctly not claiming a refund window it does not offer
    // (authoring-checklist rule 23).
    'terms.tsx': ['Terms of Service', '/refund', domain, ...(SELLS ? ['Merchant of Record'] : [])],
    'privacy.tsx': ['Privacy Policy', 'do <strong>not</strong>', `privacy@${domain}`, '30 days'],
    'refund.tsx': ['Refund Policy', `support@${domain}`, ...(SELLS ? ['14', 'Merchant of Record'] : [])],
  };

  for (const [file, mustContain] of Object.entries(pages)) {
    // Legal pages live under the marketing layout so they render with the
    // site header and footer. This used to look at the route root, where the
    // skill no longer writes — so it silently found no pages and reported the
    // content assertions as failures against files that were never read.
    const p = path.join(PROJECT_ROOT, 'src', 'routes', '_marketing', file);
    let content;
    try { content = await fs.readFile(p, 'utf-8'); } catch { fail(`page ${file}`, 'missing'); continue; }
    pass(`page ${file}`);
    // no leftover tokens
    const leftover = content.match(/\{\{[A-Z_]+\}\}/g);
    leftover ? fail(`${file}: no leftover tokens`, [...new Set(leftover)].join(', ')) : pass(`${file}: no leftover tokens`);
    // counsel review banner
    /have counsel review before launch/i.test(content) ? pass(`${file}: counsel-review banner`) : fail(`${file}: counsel-review banner`, 'missing');
    // key clauses
    for (const phrase of mustContain) {
      content.includes(phrase) ? pass(`${file}: "${phrase.slice(0, 24)}"`) : fail(`${file}: "${phrase.slice(0, 24)}"`, 'phrase missing');
    }
  }

  // privacy must encode AI-opt-out + children + the two CCPA designated methods
  // Same _marketing path as the loop above — this read was left pointing at the
  // route root and silently swallowed ENOENT into an empty string, so all three
  // content checks below reported "missing" against a file that was never read.
  // A missing page and a page failing its content checks are different failures
  // and must not look identical; read loudly and say which one happened.
  const privacyPath = path.join(PROJECT_ROOT, 'src', 'routes', '_marketing', 'privacy.tsx');
  let privacy = '';
  try {
    privacy = await fs.readFile(privacyPath, 'utf-8');
  } catch (e) {
    fail('privacy page readable', `${path.relative(PROJECT_ROOT, privacyPath)}: ${e.code || e.message} — the content checks below cannot be trusted`);
  }
  /not.*train AI|train AI models/i.test(privacy) ? pass('privacy: AI-training opt-out') : fail('privacy: AI-training opt-out', 'missing');
  /under 13|under 16/i.test(privacy) ? pass('privacy: children clause') : fail('privacy: children clause', 'missing');
  /\/privacy-request/.test(privacy) ? pass('privacy: data-request form link') : fail('privacy: data-request form link', 'missing /privacy-request');

  // build + tsc
  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  build.status === 0 ? pass('npm run build') : fail('npm run build', (build.stderr || build.stdout || '').slice(-800));
  const tsc = spawnSync('npx', ['tsc', '--noEmit'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  tsc.status === 0 ? pass('tsc --noEmit') : fail('tsc --noEmit', (tsc.stderr || tsc.stdout || '').slice(-800));

  let okC = 0;
  for (const c of checks) { console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`); if (c.ok) okC++; }
  console.log(`\n${okC}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
