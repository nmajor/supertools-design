// Competitor link blocklist — the site must NEVER give a competitor a dofollow
// link / link juice. Sourced from our own competitor research
// (docs/research/competitors.md, docs/validation/competitor-walkthroughs.md),
// NOT guessed. Used by seo-02 (drop competitor-sourced angles) and seo-04
// (drop/strip competitor citations + sources). Keep this list maintained.

export const COMPETITOR_DOMAINS = [
  // Direct competitors — AI wedding mood-board / aesthetic generators
  'itsayes.io',
  'wedvis.com',
  'moodboardai.com',
  'moodboard.ai',
  'nupt.ai',
  'weddingaissistant.com',
  'weddie.app',
  'myroomdesigner.ai',
  'checkthat.ai',
  'mixboard.com',
  'aiworthit.com',
  // Design / mood-board tools we compete with for the same job
  'canva.com',
  'milanote.com',
  // Wedding planning platforms / marketplaces (competitors & adjacents)
  'theknot.com',
  'theknotww.com',
  'zola.com',
  'withjoy.com',
  'joy.com',
  'weddingwire.com',
  'hitched.co.uk',
  'minted.com',
  'davidsbridal.com',
];

// Competitor brand TEXT mentions — distinct from COMPETITOR_DOMAINS (which is a
// URL/link blocklist). The LLM sometimes name-drops a rival's *brand* in prose
// ("use Canva", "Adobe Color"...) without ever linking it — no link juice leaks,
// but we still don't want to recommend a competitor in our own copy. This list is
// matched as whole-word TEXT (not URLs). Multi-word names are matched verbatim.
export const COMPETITOR_BRANDS = [
  'canva',
  'adobe color',
  'coolors',
  'milanote',
  'the knot',
  'theknot',
  'zola',
  'minted',
  'withjoy',
  'weddingwire',
  'wedding wire',
  'david\'s bridal',
  'davids bridal',
];

// Detect competitor brand-name TEXT mentions in a body of prose/HTML. Strips tags
// first (so it matches the rendered text, not attribute values), then whole-word
// matches each brand. Returns the de-duped list of brands found (empty = clean).
export function competitorBrandMentions(html) {
  const plain = String(html || '').replace(/<[^>]+>/g, ' ').toLowerCase();
  const hits = [];
  for (const brand of COMPETITOR_BRANDS) {
    const esc = brand.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // \b is unreliable around apostrophes; bound on non-letter edges instead.
    const re = new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, 'i');
    if (re.test(plain)) hits.push(brand);
  }
  return [...new Set(hits)];
}

// Normalized registrable host (lowercased, no leading www) — shared by the
// competitor + own-domain predicates so host-matching lives in one place.
export function registrableHost(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

// example.com / *.example.com is the reserved placeholder domain (RFC 2606) — it
// must NEVER reach a shipped page. The LLM emits "<brand>.example.com/path" and
// similar as fake self-links. Matched on host so query/path don't matter.
export function isExampleUrl(url) {
  const host = registrableHost(url);
  return host === 'example.com' || host.endsWith('.example.com');
}

const hostMatches = (host, domain) => !!host && (host === domain || host.endsWith(`.${domain}`));

// Registrable-domain match (so blog.itsayes.io and itsayes.io/path both match).
export function isCompetitorUrl(url) {
  const host = registrableHost(url);
  return COMPETITOR_DOMAINS.some((d) => hostMatches(host, d));
}

// Build an "is this our own site?" predicate from the project's site origin.
// Used to keep internal links same-tab and to exclude ourselves from Sources.
export function makeIsOwnUrl(siteOrigin) {
  const own = registrableHost(siteOrigin);
  if (!own) {
    throw new Error(
      `makeIsOwnUrl: could not derive a host from siteOrigin ${JSON.stringify(siteOrigin)} — ` +
      'set "site_origin" in the skill config (e.g. "https://example-brand.com").'
    );
  }
  return (url) => hostMatches(registrableHost(url), own);
}

// Strip competitor <a href> from an HTML string, keeping the anchor text
// (so we never leak a link even if one slips into generated body HTML).
export function stripCompetitorLinks(html) {
  return String(html).replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) =>
    isCompetitorUrl(href) ? text : m
  );
}
