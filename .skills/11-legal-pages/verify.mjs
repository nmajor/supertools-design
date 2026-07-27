#!/usr/bin/env node
// 11-legal-pages verifier.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };

async function main() {
  loadEnv();
  const project = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8'));
  const domain = project.domain;

  const pages = {
    'terms.tsx': ['Terms of Service', 'Merchant of Record', '/refund', domain],
    'privacy.tsx': ['Privacy Policy', 'do <strong>not</strong>', `privacy@${domain}`, '30 days'],
    'refund.tsx': ['Refund Policy', '14', 'Merchant of Record', `support@${domain}`],
  };

  for (const [file, mustContain] of Object.entries(pages)) {
    const p = path.join(PROJECT_ROOT, 'src', 'routes', file);
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
  const privacy = await fs.readFile(path.join(PROJECT_ROOT, 'src/routes/privacy.tsx'), 'utf-8').catch(() => '');
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
