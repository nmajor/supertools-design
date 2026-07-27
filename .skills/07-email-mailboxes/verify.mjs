#!/usr/bin/env node
// 07-email-mailboxes verifier.
// Mailboxes exist (DA) + DNS resolves publicly + DKIM present + IMAP login works.

import fs from 'node:fs/promises';
import path from 'node:path';
import dnsp from 'node:dns/promises';
import tls from 'node:tls';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { directAdmin, mxRecords } from '../_shared/mxroute.mjs';

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };

const MAILBOXES = [
  { local: 'support', envKey: 'MXROUTE_SUPPORT_PASSWORD' },
  { local: 'privacy', envKey: 'MXROUTE_PRIVACY_PASSWORD' },
];

// Minimal IMAP login over TLS (port 993). Resolves true on tagged OK.
function imapLogin(host, email, password, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let buf = '';
    let stage = 'greeting';
    let done = false;
    const finish = (ok) => { if (!done) { done = true; try { sock.end(); } catch {} resolve(ok); } };
    const sock = tls.connect({ host, port: 993, servername: host }, () => {});
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.on('error', () => finish(false));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (stage === 'greeting' && /\*\s+OK/i.test(buf)) {
        stage = 'login'; buf = '';
        sock.write(`a1 LOGIN "${email}" "${password.replace(/(["\\])/g, '\\$1')}"\r\n`);
      } else if (stage === 'login') {
        if (/^a1\s+OK/im.test(buf)) finish(true);
        else if (/^a1\s+(NO|BAD)/im.test(buf)) finish(false);
      }
    });
  });
}

async function main() {
  loadEnv();
  requireEnv(['MXROUTE_SERVER', 'CLOUDFLARE_API_TOKEN']);
  const project = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', 'project.json'), 'utf-8'));
  const domain = project.domain;
  const server = process.env.MXROUTE_SERVER;
  dnsp.setServers(['1.1.1.1', '8.8.8.8']);

  // Mailboxes exist on DA
  const list = await directAdmin('/CMD_API_POP', { action: 'list', domain });
  const listText = JSON.stringify(list.body);
  for (const mb of MAILBOXES) {
    new RegExp(`"${mb.local}"|${mb.local}@${domain}`, 'i').test(listText)
      ? pass(`mailbox ${mb.local}@${domain} exists`)
      : fail(`mailbox ${mb.local}@${domain} exists`, 'not in DA POP list');
  }

  // DNS resolves (short retry — CF propagates fast)
  const resolveWithRetry = async (fn, ms = 60000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      try { const v = await fn(); if (v) return v; } catch {}
      await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
  };

  // MX must be EXACTLY the authoritative set — no foreign/stale MX that
  // would split inbound mail.
  const wantMx = mxRecords()
    .map((m) => `${m.priority} ${m.exchange.toLowerCase().replace(/\.$/, '')}`)
    .sort();
  const mx = await resolveWithRetry(async () => {
    const r = await dnsp.resolveMx(domain);
    return r.length ? r : null;
  });
  if (!mx) {
    fail('MX set exact', 'not resolving within 60s');
  } else {
    const gotMx = mx.map((m) => `${m.priority} ${m.exchange.toLowerCase().replace(/\.$/, '')}`).sort();
    JSON.stringify(gotMx) === JSON.stringify(wantMx)
      ? pass('MX set exact', gotMx.join(', '))
      : fail('MX set exact', `got [${gotMx.join(', ')}] want [${wantMx.join(', ')}]`);
  }

  const spf = await resolveWithRetry(async () => {
    const r = (await dnsp.resolveTxt(domain)).map((t) => t.join(''));
    return r.find((t) => /^v=spf1.*mxroute/i.test(t)) || null;
  });
  spf ? pass('SPF includes mxroute', spf) : fail('SPF includes mxroute', 'not resolving');

  const dmarc = await resolveWithRetry(async () => {
    const r = (await dnsp.resolveTxt(`_dmarc.${domain}`)).map((t) => t.join(''));
    return r.find((t) => /^v=DMARC1/i.test(t)) || null;
  });
  dmarc ? pass('DMARC present', dmarc) : fail('DMARC present', 'not resolving');

  const dkim = await resolveWithRetry(async () => {
    const r = (await dnsp.resolveTxt(`x._domainkey.${domain}`)).map((t) => t.join(''));
    return r.find((t) => /v=DKIM1/i.test(t)) || null;
  });
  dkim ? pass('DKIM present', 'x._domainkey resolves DKIM1') : fail('DKIM present', 'x._domainkey not resolving');

  // .env passwords + IMAP login
  let env = '';
  try { env = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf-8'); } catch {}
  for (const mb of MAILBOXES) {
    const m = env.match(new RegExp(`^${mb.envKey}=(.+)$`, 'm'));
    if (!m) { fail(`${mb.envKey} in .env`, 'missing'); continue; }
    pass(`${mb.envKey} in .env`);
    const ok = await imapLogin(server, `${mb.local}@${domain}`, m[1].trim());
    ok ? pass(`IMAP login ${mb.local}@${domain}`)
       : fail(`IMAP login ${mb.local}@${domain}`, 'TLS:993 LOGIN failed — stale password?');
  }

  let okCount = 0;
  for (const c of checks) {
    console.log(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    if (c.ok) okCount++;
  }
  console.log(`\n${okCount}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
