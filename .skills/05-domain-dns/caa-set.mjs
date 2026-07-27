// Single source of truth for the desired CAA record set, consumed by both
// setup.mjs and verify.mjs so the promised set and the enforced set can't
// drift apart.
//
// These are the certificate authorities Cloudflare uses for Universal SSL,
// per https://developers.cloudflare.com/ssl/edge-certificates/caa-records/
// and the certificate-authorities reference. Note the Google Trust Services
// value carries the `cansignhttpexchanges=yes` parameter exactly as CF
// documents it. The list is intentionally the full documented set — a
// partial CAA set risks blocking issuance for a CA CF might fall back to.
//
// CF also auto-adds CAA records when Universal SSL is on and any CAA exists,
// so pre-existing extra CAA records (e.g. a bare `pki.goog`) are harmless and
// left in place; this module only guarantees the documented set is present.

export const CAA_VALUES = [
  'letsencrypt.org',
  'pki.goog; cansignhttpexchanges=yes',
  'ssl.com',
  'sectigo.com',
];

export const CAA_TAGS = ['issue', 'issuewild'];

// Flattened desired records: [{ tag, value }, ...] — 4 CAs × 2 tags = 8.
export const DESIRED_CAA = CAA_TAGS.flatMap((tag) =>
  CAA_VALUES.map((value) => ({ tag, value }))
);

// CF may return CAA values with surrounding quotes / whitespace differences.
export function normalizeCaaValue(v) {
  return String(v).trim().replace(/^"+|"+$/g, '').replace(/\s*;\s*/g, '; ');
}
