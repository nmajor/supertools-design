// MXroute / DirectAdmin helpers. Derives the DirectAdmin connection from the
// three keys in .env (MXROUTE_SERVER, MXROUTE_USERNAME, MXROUTE_API_KEY) — no
// extra env required. Mirrors the proven client from the tmp support POCs.

const log = (...a) => console.log(...a);

export function daBaseUrl() {
  return process.env.MXROUTE_DA_BASE_URL || `https://${process.env.MXROUTE_SERVER}:2222`;
}

// MXroute MX record set, verified against multiple live domains on this
// account: primary = <server>, relay = <first-label>-relay.<rest>.
export function mxRecords() {
  const server = process.env.MXROUTE_SERVER;
  const primary = process.env.MXROUTE_PRIMARY_MX || server;
  const relay = process.env.MXROUTE_RELAY_MX || server.replace(/^([^.]+)/, '$1-relay');
  return [
    { priority: 10, exchange: primary },
    { priority: 20, exchange: relay },
  ];
}

function authHeader() {
  const user = process.env.MXROUTE_DA_USERNAME || process.env.MXROUTE_USERNAME;
  const key = process.env.MXROUTE_DA_LOGIN_KEY || process.env.MXROUTE_API_KEY;
  return `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`;
}

// DirectAdmin legacy API. GET for read endpoints, POST (form-encoded) for
// mutations. Always asks for JSON. Returns parsed body.
export async function directAdmin(endpoint, params = {}, method = 'POST') {
  const url = `${daBaseUrl().replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
  const opts = {
    method,
    headers: { Authorization: authHeader() },
  };
  if (method === 'POST') {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams({ ...params, json: 'yes' });
  }
  const target = method === 'GET'
    ? `${url}?${new URLSearchParams({ ...params, json: 'yes' })}`
    : url;
  const r = await fetch(target, opts);
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = Object.fromEntries(new URLSearchParams(text)); }
  return { status: r.status, ok: r.ok, body };
}

export function isDaError(body) {
  return body?.error === '1' || body?.error === 1 || body?.success === 'no';
}

export function looksAlreadyExists(body) {
  return Boolean(JSON.stringify(body || '').match(/already|exists|duplicate/i));
}

// Read the DA-managed zone for a domain and pull the DKIM TXT (x._domainkey)
// + SPF. Returns { dkim: {host, value} | null, spf: string | null }.
export async function readDaMailDns(domain) {
  const r = await directAdmin('/CMD_API_DNS_CONTROL', { domain }, 'GET');
  if (!r.ok) throw new Error(`DA DNS read failed (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  const records = r.body.records || [];
  const strip = (v) => String(v).trim().replace(/^"+|"+$/g, '');
  const dkimRec = records.find((x) => x.type === 'TXT' && /_domainkey/.test(x.name || ''));
  const spfRec = records.find((x) => x.type === 'TXT' && /v=spf1/i.test(x.value || ''));
  return {
    dkim: dkimRec ? { host: dkimRec.name.replace(/\.$/, ''), value: strip(dkimRec.value) } : null,
    spf: spfRec ? strip(spfRec.value) : null,
  };
}
