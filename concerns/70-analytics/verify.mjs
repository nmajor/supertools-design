#!/usr/bin/env node
// supertools-design 70-analytics verify (smoke test)
//
// Confirms the Rybbit API key is accepted by the configured Rybbit host.
// Posts a benign event with an intentionally-invalid site_id; we don't care
// whether the event is recorded — we only care that auth is not rejected.
//
// Exit 0 = key accepted (auth ok), 1 = key rejected, 2 = config error.

import fs from 'node:fs/promises';

async function loadDotenv(file = '.env') {
  try {
    const text = await fs.readFile(file, 'utf-8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
}

await loadDotenv();

const { RYBBIT_API_KEY, RYBBIT_HOST } = process.env;
for (const [k, v] of Object.entries({ RYBBIT_API_KEY, RYBBIT_HOST })) {
  if (!v) {
    console.error(`Missing required env: ${k}`);
    process.exit(2);
  }
}

const url = `${RYBBIT_HOST.replace(/\/$/, '')}/api/track`;
const body = {
  site_id: '__supertools_smoke',
  type: 'pageview',
  pathname: '/__supertools_smoke',
};

let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RYBBIT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
} catch (e) {
  console.error(`Rybbit request failed: ${e.message}`);
  process.exit(1);
}

const text = await res.text();

if (res.status === 401 || res.status === 403) {
  console.error(`Rybbit rejected auth (${res.status}): ${text}`);
  process.exit(1);
}

console.log(`OK: Rybbit accepted auth at ${url} (status ${res.status}).`);
if (text) console.log(`Response: ${text.slice(0, 300)}`);
process.exit(0);
