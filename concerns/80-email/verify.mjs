#!/usr/bin/env node
// supertools-design 80-email verify
//
// Lightweight smoke check: domain is registered with Ahasend AND dns_valid.
// Exit 0 = good, 1 = not valid / not found, 2 = config error.

import { loadDotenv, readProjectState, requireEnv, ahasend, emailDomainFor } from './_lib.mjs';

await loadDotenv();
requireEnv(['AHASEND_API_KEY', 'AHASEND_ACCOUNT_ID']);

const state = await readProjectState();
const emailDomain =
  process.env.AHASEND_FROM_DOMAIN ||
  process.env.EMAIL_SUBDOMAIN ||
  (state && state.domain ? emailDomainFor(state.domain) : null);

if (!emailDomain) {
  console.error('Cannot determine email domain. Set AHASEND_FROM_DOMAIN or EMAIL_SUBDOMAIN, or run setup first.');
  process.exit(2);
}

const r = await ahasend(`/domains/${encodeURIComponent(emailDomain)}`);
if (r.status === 404) {
  console.error(`Ahasend domain ${emailDomain} not found.`);
  process.exit(1);
}
if (!r.ok) {
  console.error(`Ahasend GET domain failed (${r.status}): ${JSON.stringify(r.body)}`);
  process.exit(1);
}
if (!r.body.dns_valid) {
  console.error(`Ahasend says ${emailDomain} dns_valid=false. Re-run setup or check DNS records.`);
  process.exit(1);
}

console.log(`OK: ${emailDomain} dns_valid=true`);
process.exit(0);
