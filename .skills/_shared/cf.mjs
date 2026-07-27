// Cloudflare API helpers shared across DNS / email / domain skills.
// Thin wrapper over the v4 REST API using CLOUDFLARE_API_TOKEN.

const CF_BASE = 'https://api.cloudflare.com/client/v4';

export async function cf(pathSuffix, opts = {}) {
  const r = await fetch(`${CF_BASE}${pathSuffix}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  let body;
  const text = await r.text();
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: r.status, ok: r.ok && body.success !== false, body };
}

// Resolve the zone id for a root domain in the configured account.
export async function findZoneId(rootDomain) {
  const r = await cf(
    `/zones?name=${encodeURIComponent(rootDomain)}&account.id=${process.env.CLOUDFLARE_ACCOUNT_ID}`
  );
  if (!r.ok) throw new Error(`CF list zones failed: ${JSON.stringify(r.body.errors || r.body)}`);
  const zone = (r.body.result || [])[0];
  if (!zone) {
    throw new Error(
      `CF zone not found for ${rootDomain} in account ${process.env.CLOUDFLARE_ACCOUNT_ID}. ` +
      `Check the domain is in this account and the token has zone access.`
    );
  }
  return zone.id;
}

// List DNS records, optionally filtered by name+type.
export async function listDnsRecords(zoneId, { name, type } = {}) {
  const qs = new URLSearchParams({ per_page: '100' });
  if (name) qs.set('name', name);
  if (type) qs.set('type', type);
  const r = await cf(`/zones/${zoneId}/dns_records?${qs}`);
  if (!r.ok) throw new Error(`CF list records failed: ${JSON.stringify(r.body.errors || r.body)}`);
  return r.body.result || [];
}
