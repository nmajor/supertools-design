#!/usr/bin/env node
// 00-prereqs setup.
// Ensures .supertools-state/project.json exists with { projectName, domain }.
// Idempotent: if the file already exists, reports it and exits 0.
//
// Usage:
//   node .skills/00-prereqs/setup.mjs [domain] [--force]
//
// Domain resolution order:
//   1. Existing .supertools-state/project.json (always wins; no-op).
//      Changing a pinned domain requires an explicit --force.
//   2. CLI arg (the orchestrator passes the user-confirmed domain here).
//   3. Parsed from CLAUDE.md ("Primary domain: `<domain>`").
//
// If none of those yield a domain, exit non-zero and ask for it explicitly —
// never invent or assume a domain.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from '../_shared/env.mjs';

const STATE_DIR    = path.join(PROJECT_ROOT, '.supertools-state');
const PROJECT_JSON = path.join(STATE_DIR, 'project.json');
const CLAUDE_MD    = path.join(PROJECT_ROOT, 'CLAUDE.md');

const log = (...a) => console.log(...a);
const die = (m, code = 1) => { console.error(m); process.exit(code); };

async function readMaybe(p) {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}

function domainFromClaudeMd(text) {
  if (!text) return null;
  // "Primary domain: `example.com`" or "Primary domain: example.com"
  const m = text.match(/Primary domain:\s*`?([a-z0-9.-]+\.[a-z]{2,})`?/i);
  return m ? m[1].toLowerCase() : null;
}

// Normalize CLI input: tolerate scheme / trailing slash / trailing dot /
// uppercase; reject anything that doesn't look like a bare registrable domain.
function normalizeDomain(input) {
  const d = String(input).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
    die(`"${input}" does not look like a bare domain (expected e.g. example.com).`);
  }
  return d;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const rawArg = args.find((a) => !a.startsWith('--'));
  const argDomain = rawArg ? normalizeDomain(rawArg) : undefined;

  // 1. Strictly idempotent: an existing valid project.json ALWAYS wins.
  //    Replacing the domain requires an explicit --force (the project domain
  //    is foundational — later skills' receipts key off it).
  const existing = await readMaybe(PROJECT_JSON);
  if (existing && !force) {
    const parsed = JSON.parse(existing);
    if (!parsed.domain) die(`${PROJECT_JSON} exists but has no "domain". Re-run with: setup.mjs <domain> --force`);
    if (argDomain && argDomain !== parsed.domain) {
      die(`${PROJECT_JSON} already pins domain=${parsed.domain}; refusing to change it to ${argDomain}.\n` +
          `If deliberate, re-run with --force (later skills' receipts may be invalidated).`);
    }
    log(`project.json already present — domain=${parsed.domain} (no change)`);
    printSummary(parsed);
    return;
  }
  if (existing && force && !argDomain) {
    die('--force requires an explicit domain argument: setup.mjs <domain> --force');
  }

  // 2. Resolve domain: arg → CLAUDE.md.
  let domain = argDomain || null;
  let source = argDomain ? 'cli-arg' : null;
  if (!domain) {
    domain = domainFromClaudeMd(await readMaybe(CLAUDE_MD));
    source = domain ? 'CLAUDE.md' : null;
  }
  if (!domain) {
    die(
      'Could not resolve the project domain.\n' +
      'Pass it explicitly (after confirming with the user):\n' +
      '  node .skills/00-prereqs/setup.mjs <domain>\n' +
      'Do not invent or assume a domain.'
    );
  }

  const projectName = path.basename(PROJECT_ROOT);
  const record = {
    projectName,
    domain,
    domainSource: source,
    createdAt: new Date().toISOString(),
    sourceDesignFolder: PROJECT_ROOT,
  };

  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(PROJECT_JSON, JSON.stringify(record, null, 2) + '\n');
  log(`Wrote ${PROJECT_JSON} (domain=${domain}, source=${source})`);
  printSummary(record);
}

function printSummary(record) {
  console.log('---SETUP_DONE---');
  console.log(JSON.stringify({
    projectName: record.projectName,
    domain: record.domain,
    domainSource: record.domainSource || 'pre-existing',
  }, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
