// Polar (Merchant of Record) API helper. Uses POLAR_SANDBOX_ACCESS_TOKEN
// against the sandbox host by default. The token is org-scoped, so
// organization_id is inferred — never pass it in request bodies.
//
// Note: Polar 307-redirects between trailing-slash variants per resource
// (checkouts want the slash, webhooks don't). node fetch follows 307 while
// preserving method + body, so callers don't need to care.

export function polarBase() {
  return (process.env.POLAR_API_BASE || 'https://sandbox-api.polar.sh').replace(/\/+$/, '');
}

export async function polar(pathSuffix, opts = {}) {
  const r = await fetch(`${polarBase()}/v1${pathSuffix}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.POLAR_SANDBOX_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

export async function listAll(pathSuffix) {
  const r = await polar(`${pathSuffix}?limit=100`);
  return r.ok ? (r.body.items || []) : [];
}
