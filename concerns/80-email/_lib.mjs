// Shared helpers for 80-email. Keep pure-Node, no external deps.

import fs from 'node:fs/promises';

export async function loadDotenv(file = '.env') {
  try {
    const text = await fs.readFile(file, 'utf-8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // .env not present — fine, fall back to ambient process.env
  }
}

export async function readProjectState() {
  try {
    return JSON.parse(await fs.readFile('.supertools-state/project.json', 'utf-8'));
  } catch {
    return null;
  }
}

export function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(', ')}`);
    process.exit(2);
  }
}

export async function ahasend(pathSuffix, opts = {}) {
  const base = `https://api.ahasend.com/v2/accounts/${process.env.AHASEND_ACCOUNT_ID}`;
  const r = await fetch(`${base}${pathSuffix}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.AHASEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

export async function cf(pathSuffix, opts = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${pathSuffix}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await r.json();
  return { status: r.status, ok: r.ok && body.success !== false, body };
}

export function emailDomainFor(rootDomain) {
  return process.env.EMAIL_SUBDOMAIN || `email.${rootDomain}`;
}
