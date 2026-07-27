#!/usr/bin/env node
// 00-prereqs verifier. Run after .supertools-state/project.json exists.
// Probes every credential and CLI. Exit 0 = all green; exit 1 = halt loudly.
//
// Gate on the credential / CLI / domain prerequisites for the service set:
// Polar MoR payments, OpenRouter/OpenAI/Fireworks LLM providers, DataForSEO
// scraping, MXroute mailboxes + Chatwoot support (both required), two-account
// Cloudflare split (platform + SITES incl. R2 S3 creds).
// All keys live in .env; the machine env also carries DataForSEO/OpenRouter/
// OpenAI and wins on conflict (loadEnv never overrides process.env).
//
// Secret hygiene is enforced BY CONSTRUCTION: every check name/detail passes
// through redact(), which strips every env-derived value (from .env keys and
// the requires.json contract) before it is stored or printed — response
// bodies, URLs, and exception messages included. Value fragments of keys are
// never echoed; checks report key NAMES and verdicts only.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { loadEnv, requireEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { hasCli, claudePing, codexPing, geminiPing } from '../_shared/cli.mjs';
import { checkExport, REQUIRED_EXPORT_FILES, fontFamilies, palette, googleFontsUrl } from '../_shared/design-os.mjs';
import requires from './requires.json' with { type: 'json' };

// --- redaction layer -------------------------------------------------------
// [key, value] pairs to strip from any logged text; longest values first so
// overlapping values can't leave fragments behind. Covers BOTH the effective
// process.env value AND the raw value written in .env — machine env shadows
// .env (loadEnv never overrides), so a shadowed .env credential must still
// be redacted.
let SECRET_VALUES = [];
let ENV_FILE_KEYS = new Set();

function collectSecrets() {
  const keys = new Set([...requires.envRequired, ...(requires.envOptional ?? [])]);
  const pairs = new Map(); // value -> key (dedupe by value)
  try {
    const envText = fsSync.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf-8');
    for (const line of envText.split('\n')) {
      if (line.startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      keys.add(m[1]);
      const raw = m[2].replace(/^["']|["']$/g, '');
      if (raw.length >= 4) { ENV_FILE_KEYS.add(m[1]); pairs.set(raw, m[1]); }
      else if (m[2] !== '') ENV_FILE_KEYS.add(m[1]);
    }
  } catch {}
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.length >= 4 && !pairs.has(v)) pairs.set(v, k);
  }
  SECRET_VALUES = [...pairs.entries()]
    .map(([v, k]) => [k, v])
    .sort((a, b) => b[1].length - a[1].length);
}

function redact(text) {
  let out = String(text ?? '');
  for (const [k, v] of SECRET_VALUES) out = out.split(v).join(`<REDACTED:${k}>`);
  return out;
}

// --- check bookkeeping (redaction applied at the single entry point) --------
const checks = [];
const fail = (name, detail = '') => { checks.push({ name: redact(name), ok: false, detail: redact(detail) }); };
const pass = (name, detail = '') => { checks.push({ name: redact(name), ok: true, detail: redact(detail) }); };

// Optional key groups: all-or-nothing. Some-but-not-all set = a config
// mistake and fails loudly, naming the missing key NAMES only.
function optionalGroup(name, keys) {
  const present = keys.filter((k) => process.env[k]);
  if (present.length === 0) return 'absent';
  if (present.length === keys.length) return 'full';
  fail(name, `partially configured — missing: ${keys.filter((k) => !process.env[k]).join(', ')}`);
  return 'partial';
}

async function readProject() {
  const p = path.join(PROJECT_ROOT, '.supertools-state', 'project.json');
  const text = await fs.readFile(p, 'utf-8');
  return JSON.parse(text);
}

async function probe(name, url, init = {}, validate) {
  try {
    const r = await fetch(url, init);
    const body = await r.text();
    if (validate) {
      const v = validate(r, body);
      if (v === true) return pass(name, `HTTP ${r.status}`);
      return fail(name, v || `HTTP ${r.status} ${body.slice(0, 200)}`);
    }
    if (!r.ok) return fail(name, `HTTP ${r.status} ${body.slice(0, 200)}`);
    pass(name, `HTTP ${r.status}`);
  } catch (e) {
    fail(name, e.message);
  }
}

async function main() {
  // .env load failure is a reported FAIL row, not an unhandled throw — the
  // report path and exit-1 semantics documented in SKILL.md hold either way.
  try {
    loadEnv();
  } catch (e) {
    fail('.env load', e.message);
    report();
    return;
  }
  collectSecrets();

  // 0. Design OS export. This is the pipeline's STARTING ASSUMPTION, so it is
  //    checked before credentials: skills 02/03/04 read the palette, the fonts,
  //    and the shell out of design/product-plan/ and have no brand of their own
  //    to fall back on. An incomplete export is a halt, not a warning.
  {
    const x = checkExport();
    if (!x.ok) {
      fail('design os export',
        `${x.missing.length}/${REQUIRED_EXPORT_FILES.length} required files missing under ${x.exportDir}: ` +
        `${x.missing.join(', ')}. Run Design OS to completion and finish with its /export-product step — ` +
        `supertools-design starts from that export.`);
    } else {
      // Present is not the same as usable: 02 needs font stacks, 04 needs a
      // primary colour. Name what is unusable now rather than failing in 04.
      const f = fontFamilies();
      const p = palette();
      const thin = [];
      if (!f.heading && !f.body) thin.push('no --font-* stacks in tokens.css and no font role table in fonts.md');
      if (!p.primary) thin.push('no primary colour token (--color-primary or --color-primary-<n>) in tokens.css');
      thin.length
        ? fail('design os export', `${x.exportDir} present but unusable: ${thin.join('; ')}`)
        : pass('design os export',
            `${x.present.length} required files; fonts from ${f.source}; ` +
            `webfont sheet from ${googleFontsUrl().source}`);
    }
  }

  // 1. Env keys (required set). Resolution is against the MERGED environment
  //    (.env + machine env; machine wins) — that is what later skills see via
  //    loadEnv. Any required key satisfied only by the machine env is named,
  //    so .env completeness is visible, never assumed.
  try {
    requireEnv(requires.envRequired);
    const machineOnly = requires.envRequired.filter((k) => !ENV_FILE_KEYS.has(k));
    pass('env keys', machineOnly.length
      ? `${requires.envRequired.length} present; machine-env only (not in .env): ${machineOnly.join(', ')}`
      : `${requires.envRequired.length} present, all in .env`);
  } catch (e) {
    fail('env keys', e.message);
  }

  // 2. CLIs on PATH
  for (const bin of requires.cliRequired) {
    hasCli(bin) ? pass(`cli: ${bin}`) : fail(`cli: ${bin}`, 'not on PATH');
  }

  // 3. claude + codex + gemini round-trips
  const c = claudePing();
  c.status === 0 ? pass('claude -p round-trip')
                 : fail('claude -p round-trip', (c.stderr || c.stdout || '').slice(0, 300));

  const cx = codexPing(PROJECT_ROOT);
  cx.status === 0 ? pass('codex exec round-trip')
                  : fail('codex exec round-trip', (cx.stderr || cx.stdout || '').slice(0, 300));

  const g = geminiPing();
  g.status === 0 ? pass('gemini -p round-trip')
                 : fail('gemini -p round-trip', (g.stderr || g.stdout || '').slice(0, 300));

  // 4. Project domain
  let project;
  try { project = await readProject(); pass('project.json', `domain=${project.domain}`); }
  catch (e) { fail('project.json', `Run SKILL.md step 1 to create .supertools-state/project.json: ${e.message}`); }

  // 5. Cloudflare PLATFORM zone read for the project domain
  if (project?.domain) {
    await probe(
      `cf zone access (${project.domain})`,
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(project.domain)}&account.id=${process.env.CLOUDFLARE_ACCOUNT_ID}`,
      { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } },
      (r, body) => {
        if (!r.ok) return `HTTP ${r.status} ${body.slice(0, 200)}`;
        const j = JSON.parse(body);
        if (!j.result?.length) {
          return 'Zone not in the platform CF account. Widen the token at https://dash.cloudflare.com/profile/api-tokens (set "All zones from an account") or move the zone in.';
        }
        return true;
      }
    );
  } else {
    fail('cf zone access', 'skipped — no project.json domain to check');
  }

  // 5b. SITES account (second CF account for customer-website serving) —
  //     optional group; skills 13+ hard-require it before running.
  //     (Account-scoped /accounts/:id/tokens/verify is the documented endpoint
  //     for account-owned tokens; user-scoped /user/tokens/verify is for user tokens.)
  const sitesState = optionalGroup('cf SITES account', ['CLOUDFLARE_SITES_ACCOUNT_ID', 'CLOUDFLARE_SITES_API_TOKEN']);
  if (sitesState === 'full') {
    await probe(
      'cf SITES account token',
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_SITES_ACCOUNT_ID}/tokens/verify`,
      { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_SITES_API_TOKEN}` } },
      (r, body) => {
        if (!r.ok) return `HTTP ${r.status} ${body.slice(0, 200)}`;
        const j = JSON.parse(body);
        return j.result?.status === 'active' ? true : `token status: ${j.result?.status}`;
      }
    );
    process.env.CLOUDFLARE_SITES_ACCOUNT_ID === process.env.CLOUDFLARE_ACCOUNT_ID
      ? fail('cf account split', 'SITES account id equals PLATFORM account id — that defeats the two-account split')
      : pass('cf account split', 'distinct account ids');
  } else if (sitesState === 'absent') {
    pass('cf SITES account', 'not configured (optional here) — required before 13-registrar-adapter and tenant-serving work');
  }

  // 5c. SITES-account R2 S3 credentials (tenant site storage) — optional
  //     group. Real SigV4-signed ListBuckets; auth failures return 403.
  const r2State = optionalGroup('cf SITES r2 s3 creds', [
    'CLOUDFLARE_SITES_R2_ACCESS_KEY_ID', 'CLOUDFLARE_SITES_R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_SITES_R2_S3_API_ENDPOINT',
  ]);
  if (r2State === 'full') {
    try {
      const { createHash, createHmac } = await import('node:crypto');
      const endpoint = new URL(process.env.CLOUDFLARE_SITES_R2_S3_API_ENDPOINT);
      const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const date = now.slice(0, 8);
      const region = 'auto', service = 's3';
      const payloadHash = createHash('sha256').update('').digest('hex');
      const headers = `host:${endpoint.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${now}\n`;
      const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
      const canonical = `GET\n/\n\n${headers}\n${signedHeaders}\n${payloadHash}`;
      const scope = `${date}/${region}/${service}/aws4_request`;
      const toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
      let key = createHmac('sha256', `AWS4${process.env.CLOUDFLARE_SITES_R2_SECRET_ACCESS_KEY}`).update(date).digest();
      for (const part of [region, service, 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
      const signature = createHmac('sha256', key).update(toSign).digest('hex');
      await probe('cf SITES r2 s3 creds', `${endpoint.origin}/`, {
        headers: {
          'x-amz-date': now,
          'x-amz-content-sha256': payloadHash,
          Authorization: `AWS4-HMAC-SHA256 Credential=${process.env.CLOUDFLARE_SITES_R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
      }, (r, body) => r.ok ? true : `HTTP ${r.status} ${body.slice(0, 200)}`);
    } catch (e) {
      fail('cf SITES r2 s3 creds', e.message);
    }
  } else if (r2State === 'absent') {
    pass('cf SITES r2 s3 creds', 'not configured (optional here) — required by the serving/publish skills');
  }

  // 6. Ahasend (account-scoped path; AHASEND_API_KEY aliased from SECRET_KEY in env.mjs)
  await probe(
    'ahasend api',
    `https://api.ahasend.com/v2/accounts/${process.env.AHASEND_ACCOUNT_ID}/domains?limit=1`,
    { headers: { Authorization: `Bearer ${process.env.AHASEND_API_KEY}` } }
  );

  // 7. Polar sandbox (MoR payments — sandbox org first; skill 09 creates products)
  await probe('polar sandbox', 'https://sandbox-api.polar.sh/v1/organizations/', {
    headers: { Authorization: `Bearer ${process.env.POLAR_SANDBOX_ACCESS_TOKEN}` },
  });

  // 8. OpenRouter (key metadata endpoint)
  await probe('openrouter api', 'https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  });

  // 8a. OpenAI (optional — aux/fallback provider for skill 10)
  if (process.env.OPENAI_API_KEY) {
    await probe('openai api', 'https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
  } else {
    pass('openai api', 'not configured (optional) — aux provider for 10-llm-layer');
  }

  // 8b. Fireworks (optional — verifies the key AND that glm-5p2 is actually served,
  //     since the generation trials depend on that specific model)
  if (process.env.FIREWORKS_API_KEY) {
    await probe('fireworks api (glm-5p2 served)', 'https://api.fireworks.ai/inference/v1/models', {
      headers: { Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}` },
    }, (r, body) => {
      if (!r.ok) return `HTTP ${r.status} ${body.slice(0, 200)}`;
      try {
        const j = JSON.parse(body);
        return j.data?.some((m) => /\/glm-5p2$/.test(m.id))
          ? true
          : 'key accepted but glm-5p2 is not in the served model list';
      } catch { return 'model list did not parse as JSON'; }
    });
  } else {
    pass('fireworks api', 'not configured (optional) — GLM 5.2 trials for 10-llm-layer');
  }

  // 9. DataForSEO (GBP prospect scraping; REST basic auth)
  {
    const auth = Buffer.from(
      `${process.env.DATAFORSEO_USERNAME}:${process.env.DATAFORSEO_PASSWORD}`
    ).toString('base64');
    await probe('dataforseo api', 'https://api.dataforseo.com/v3/appendix/user_data', {
      headers: { Authorization: `Basic ${auth}` },
    });
  }

  // 9b. Chatwoot platform + user tokens (support chat). Required — an empty
  //     host is a FAIL, never a silent skip.
  const cwHost = (process.env.CHATWOOT_HOST || '').replace(/\/+$/, '');
  if (cwHost) {
    await probe('chatwoot platform token', `${cwHost}/platform/api/v1/accounts`, {
      headers: { api_access_token: process.env.CHATWOOT_PLATFORM_ACCESS_TOKEN },
    });
    await probe('chatwoot user token', `${cwHost}/api/v1/profile`, {
      headers: { api_access_token: process.env.CHATWOOT_ACCESS_TOKEN },
    });
  } else {
    fail('chatwoot probes', 'CHATWOOT_HOST empty — required probes skipped');
  }

  // 9c. MXroute DirectAdmin (support mailboxes). Required — same rule.
  const mxServer = process.env.MXROUTE_SERVER;
  if (mxServer) {
    const auth = Buffer.from(
      `${process.env.MXROUTE_USERNAME}:${process.env.MXROUTE_API_KEY}`
    ).toString('base64');
    await probe('mxroute directadmin', `https://${mxServer}:2222/CMD_API_DOMAIN`, {
      headers: { Authorization: `Basic ${auth}` },
    });
  } else {
    fail('mxroute directadmin', 'MXROUTE_SERVER empty — required probe skipped');
  }

  // 10. Porkbun (optional registrar fallback) — all-or-nothing group.
  const pbState = optionalGroup('porkbun api', ['PORKBUN_API_KEY', 'PORKBUN_SECRET_KEY']);
  if (pbState === 'full') {
    await probe('porkbun api', 'https://api.porkbun.com/api/json/v3/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: process.env.PORKBUN_API_KEY,
        secretapikey: process.env.PORKBUN_SECRET_KEY,
      }),
    });
  } else if (pbState === 'absent') {
    pass('porkbun api', 'not configured (optional) — registrar fallback for 13-registrar-adapter');
  }

  // 11. Rybbit — host reachable + key format. Required — empty host FAILs.
  //     The rb_ key is a public site identifier consumed by the tracking
  //     snippet; real validity is exercised in skill 07-analytics.
  const rybbitHost = (process.env.RYBBIT_HOST || '').replace(/\/+$/, '');
  if (rybbitHost) {
    await probe(
      'rybbit host reachable',
      `${rybbitHost}/api/health`,
      {},
      (r) => r.ok ? true : `HTTP ${r.status} — host unreachable or unhealthy.`
    );
  } else {
    fail('rybbit host reachable', 'RYBBIT_HOST empty — required probe skipped');
  }
  // Never echo any value-derived fragment of a key into logs — name + verdict only.
  /^rb_[A-Za-z0-9_-]{16,}$/.test(process.env.RYBBIT_API_KEY || '')
    ? pass('rybbit key format', 'matches rb_<base62>')
    : fail('rybbit key format', 'RYBBIT_API_KEY does not match the expected rb_<base62> shape');

  // 12. Healthchecks. Required — empty host FAILs.
  const hcHost = (process.env.HEALTHCHECK_HOST || '').replace(/\/+$/, '');
  if (hcHost) {
    await probe('healthchecks', `${hcHost}/api/v3/checks/`, {
      headers: { 'X-Api-Key': process.env.HEALTHCHECK_API_KEY },
    });
  } else {
    fail('healthchecks', 'HEALTHCHECK_HOST empty — required probe skipped');
  }

  report();
}

function report() {
  let okCount = 0;
  for (const c of checks) {
    const mark = c.ok ? 'OK ' : 'FAIL';
    console.log(`[${mark}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    if (c.ok) okCount++;
  }
  console.log(`\n${okCount}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(redact(e.stack || e.message)); process.exit(2); });
