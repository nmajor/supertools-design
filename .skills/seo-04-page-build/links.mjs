// seo-04 link policy — one place for every link decision on the page body and
// the Sources block. Competitor/own-domain *classification* lives in
// _shared/competitors.mjs; this module owns the *rendering* rules:
//   - sanitize untrusted LLM HTML
//   - strip competitor links (belt-and-suspenders, never give a rival link juice)
//   - externalize editorial citations: dofollow + target=_blank + rel=noopener,
//     leaving our own/internal links same-tab
//   - cap repeated links to the same URL (no link dumps)
//   - assemble the Sources reference list (exclude competitor + own, dedupe)
// Grounded in docs/seo/content-voice-guide.md §4 + content-seo-intent-linking.md.

import { isCompetitorUrl, stripCompetitorLinks, isExampleUrl, registrableHost } from '../_shared/competitors.mjs';

// Strip any <a href> pointing at the reserved example.com placeholder domain,
// keeping the anchor text. The LLM emits "<brand>.example.com/path" as a fake
// self-link; it must never ship. (Belt-and-suspenders to the verify gate.)
function stripExampleLinks(html) {
  return String(html).replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) =>
    isExampleUrl(href) ? text : m
  );
}

// Rewrite absolute self-links to relative. An LLM-drafted body should link to our
// own pages with relative paths ("/path"), not absolute "https://<own-host>/path"
// — absolute self-links are brittle (env/preview hosts) and bad practice. Only the
// href is touched; same-host means our own registrable domain.
function relativizeSelfLinks(html, ownHost) {
  return String(html).replace(/(<a\s+[^>]*href=")(https?:\/\/[^"]+)(")/gi, (m, pre, href, post) => {
    if (registrableHost(href) !== ownHost) return m;
    try {
      const u = new URL(href);
      const rel = `${u.pathname}${u.search}${u.hash}` || '/';
      return `${pre}${rel}${post}`;
    } catch { return m; }
  });
}

function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*style[\s\S]*?<\s*\/\s*style\s*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\s(class|style)\s*=\s*"[^"]*"/gi, '')
    .replace(/\s(class|style)\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '')
    .trim();
}

// Outbound editorial citations -> dofollow + open in a new tab + rel=noopener
// (security only; nofollow-ing your own citations is stale dogma). Our own links
// stay same-tab. Any model-emitted rel= is dropped first so we never duplicate it.
function externalizeLinks(html, isOwnUrl) {
  return String(html).replace(/<a\s+href="(https?:\/\/[^"]+)"([^>]*)>/gi, (m, href, rest) => {
    if (/target=/i.test(rest) || isOwnUrl(href)) return m; // leave own/already-targeted links alone
    const cleaned = rest.replace(/\s+rel="[^"]*"/i, '');
    return `<a href="${href}"${cleaned} target="_blank" rel="noopener">`;
  });
}

// Keep the first `maxPerUrl` links to each URL; unlink the rest but keep the text.
function capRepeatedLinks(html, maxPerUrl = 2) {
  const counts = {};
  return String(html).replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
    counts[href] = (counts[href] || 0) + 1;
    return counts[href] <= maxPerUrl ? m : text;
  });
}

/**
 * The body-HTML pipeline. ORDER IS LOAD-BEARING:
 *   sanitize -> strip example.com -> strip competitors -> relativize self-links
 *   -> externalize -> cap repeats.
 * (Drop example.com + competitor links first so they're unlinked before anything
 *  else touches them; relativize our own absolute links before externalize so they
 *  read as internal/same-tab; cap last so it only counts surviving links.)
 */
export function processBodyHtml(html, { isOwnUrl, ownHost, maxPerUrl = 2 }) {
  let out = sanitizeHtml(html);
  out = stripExampleLinks(out);
  out = stripCompetitorLinks(out);
  out = relativizeSelfLinks(out, ownHost);
  out = externalizeLinks(out, isOwnUrl);
  out = capRepeatedLinks(out, maxPerUrl);
  return out;
}

/**
 * Build the Sources reference list from the FINAL body links ∪ the research
 * angle URLs ∪ the model's claimed sources. Excludes competitors + our own
 * domain, dedupes, and labels each with a (cleaned) hostname.
 */
export function buildSources({ bodyHtml, angleUrls = [], metaSources = [], isOwnUrl, clean = (s) => s }) {
  const hostLabel = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const bodyUrls = [...String(bodyHtml).matchAll(/<a [^>]*href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]);
  const metaUrls = (Array.isArray(metaSources) ? metaSources : []).map((s) => s && s.url).filter(Boolean);
  const seen = new Set();
  return [...bodyUrls, ...angleUrls, ...metaUrls]
    .filter((u) => /^https?:\/\//.test(u) && !isExampleUrl(u) && !isCompetitorUrl(u) && !isOwnUrl(u) && !seen.has(u) && seen.add(u))
    .map((u) => ({ url: u, label: clean(hostLabel(u)) }));
}
