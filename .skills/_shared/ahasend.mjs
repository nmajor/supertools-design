// Ahasend API helper (transactional email). Account-scoped v2 API, Bearer
// auth. Adapted from a proven prior implementation (git history has lineage).

const log = (...a) => console.log(...a);

// opts.apiKey overrides the bearer token (e.g. to send with a narrow
// domain-scoped key rather than the management key). Defaults to
// AHASEND_API_KEY.
export async function ahasend(pathSuffix, opts = {}) {
  const base = `https://api.ahasend.com/v2/accounts/${process.env.AHASEND_ACCOUNT_ID}`;
  const { apiKey, ...fetchOpts } = opts;
  const r = await fetch(`${base}${pathSuffix}`, {
    ...fetchOpts,
    headers: {
      Authorization: `Bearer ${apiKey || process.env.AHASEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

// Convention: transactional email runs on a dedicated subdomain so its
// reputation is isolated. Resolution:
//   - EMAIL_DOMAIN set      → use it verbatim (full override, e.g. "mail.acme.com")
//   - EMAIL_SUBDOMAIN set   → "<EMAIL_SUBDOMAIN>.<rootDomain>" (label, e.g. "mail")
//   - neither               → "email.<rootDomain>" (default)
export function emailDomainFor(rootDomain) {
  if (process.env.EMAIL_DOMAIN) return process.env.EMAIL_DOMAIN;
  if (process.env.EMAIL_SUBDOMAIN) return `${process.env.EMAIL_SUBDOMAIN}.${rootDomain}`;
  return `email.${rootDomain}`;
}
