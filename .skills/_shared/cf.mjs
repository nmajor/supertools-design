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

// The zone candidates for a host, most-specific first.
//
//   couch2customers.nmajor.com → ["couch2customers.nmajor.com", "nmajor.com"]
//   nmajor.com                 → ["nmajor.com"]
//
// The project domain is NOT always an apex. Deploying to a subdomain of a zone
// you already own is the correct pre-launch pattern when the apex has not been
// bought yet, and treating the project domain as a zone name broke every such
// project with a misleading "widen your token" message.
//
// Stops at two labels: a single label is never a zone, and Cloudflare will
// simply not return a zone for a public suffix like "co.uk", so trying it is
// harmless and avoids shipping a public-suffix list.
export function zoneCandidates(host) {
  const labels = String(host).toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 <= labels.length; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/**
 * Work out whether this token can reach the zone that serves `host`, and if
 * not, WHY. The three failure modes need different fixes, and telling someone
 * to widen a token that is already sufficient is worse than saying nothing.
 *
 * @returns {Promise<
 *   | {ok: true, zone: {id: string, name: string}, host: string, exact: boolean}
 *   | {ok: false, reason: 'wrong-account', zoneName: string, zoneAccountId: string, candidates: string[]}
 *   | {ok: false, reason: 'no-zone-in-account', candidates: string[], zonesVisibleInAccount: number}
 *   | {ok: false, reason: 'token-cannot-list-zones', detail: string, candidates: string[]}
 * >}
 */
export async function diagnoseZoneAccess(host, accountId = process.env.CLOUDFLARE_ACCOUNT_ID) {
  const candidates = zoneCandidates(host);

  // 1. The happy path: the most specific candidate that is a zone in this account.
  for (const name of candidates) {
    const r = await cf(`/zones?name=${encodeURIComponent(name)}&account.id=${accountId}`);
    if (!r.ok) {
      return {
        ok: false, reason: 'token-cannot-list-zones', candidates,
        detail: `HTTP ${r.status} ${JSON.stringify(r.body.errors || r.body).slice(0, 200)}`,
      };
    }
    const zone = (r.body.result || [])[0];
    if (zone) {
      return {
        ok: true, host, exact: zone.name === String(host).toLowerCase(),
        zone: { id: zone.id, name: zone.name },
      };
    }
  }

  // 2. Not in THIS account — but can the token see it elsewhere? That is a
  //    "wrong account" problem, not a token-scope problem.
  for (const name of candidates) {
    const r = await cf(`/zones?name=${encodeURIComponent(name)}`);
    if (!r.ok) continue;
    const zone = (r.body.result || [])[0];
    if (zone) {
      return {
        ok: false, reason: 'wrong-account', candidates,
        zoneName: zone.name, zoneAccountId: zone.account?.id || '(unknown)',
      };
    }
  }

  // 3. Nothing found. Distinguish "the token cannot read zones at all" from
  //    "the token reads this account fine and the zone genuinely is not here".
  const probe = await cf(`/zones?account.id=${accountId}&per_page=1`);
  if (!probe.ok) {
    return {
      ok: false, reason: 'token-cannot-list-zones', candidates,
      detail: `HTTP ${probe.status} ${JSON.stringify(probe.body.errors || probe.body).slice(0, 200)}`,
    };
  }
  return {
    ok: false, reason: 'no-zone-in-account', candidates,
    zonesVisibleInAccount: probe.body.result_info?.total_count ?? (probe.body.result || []).length,
  };
}

/** Human-readable, fix-specific message for a failed diagnoseZoneAccess(). */
export function zoneAccessMessage(host, d) {
  const tried = d.candidates.join(' → ');
  switch (d.reason) {
    case 'wrong-account':
      return `Zone "${d.zoneName}" serves ${host} but lives in Cloudflare account ${d.zoneAccountId}, ` +
             `not CLOUDFLARE_ACCOUNT_ID. Move the zone into the platform account, or point ` +
             `CLOUDFLARE_ACCOUNT_ID at the account that owns it. (tried: ${tried})`;
    case 'no-zone-in-account':
      return `No zone serving ${host} exists in this Cloudflare account — the token reads the ` +
             `account fine (${d.zonesVisibleInAccount} zones visible), the zone simply is not there. ` +
             `Add the domain to this account, or use a host under a zone you already own. ` +
             `(tried: ${tried})`;
    case 'token-cannot-list-zones':
      return `The Cloudflare token cannot list zones: ${d.detail}. Widen it at ` +
             `https://dash.cloudflare.com/profile/api-tokens (Zone:Read, "All zones from an account"). ` +
             `(tried: ${tried})`;
    default:
      return `Could not resolve a zone for ${host}. (tried: ${tried})`;
  }
}

/**
 * Resolve the zone that serves `host` — the host's own zone if it is one,
 * otherwise the nearest parent zone. DNS record names are FQDNs, so writing
 * `couch2customers.nmajor.com` records into the `nmajor.com` zone is correct
 * and correctly scoped.
 *
 * @returns {Promise<{id: string, name: string, host: string, exact: boolean}>}
 */
export async function resolveZone(host) {
  const d = await diagnoseZoneAccess(host);
  if (!d.ok) throw new Error(zoneAccessMessage(host, d));
  return { id: d.zone.id, name: d.zone.name, host: d.host, exact: d.exact };
}

/**
 * Zone id for the zone serving `host`. Kept for the existing callers (05, 06,
 * 07); they gain subdomain support for free.
 */
export async function findZoneId(host) {
  return (await resolveZone(host)).id;
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
