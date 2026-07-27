// Crawl4AI client — fetch a URL's main content as clean markdown.
// Local service (docker), default http://localhost:11235, override CRAWL4AI_URL.
// Pure fetcher; caching is the caller's job (seo.mjs diskCache).

const BASE = () => (process.env.CRAWL4AI_URL || 'http://localhost:11235').replace(/\/$/, '');

export async function crawl4aiHealthy(timeoutMs = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE()}/health`, { signal: ac.signal });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    return j.status === 'ok' || r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Crawl one URL -> { url, success, status, markdown, word_count }.
 *
 * Uses /crawl with a SERVER-SIDE page_timeout so bot-walled / heavy pages
 * (Reddit, Pinterest, etc.) fail fast instead of hanging the request — the bare
 * /md endpoint has no internal bound and will hang indefinitely on those.
 *
 * Never throws on a bad page: returns success:false with a status reason
 * (blocked | timeout | http-4xx/5xx | empty | error) so the caller degrades
 * gracefully (the brief falls back to the SERP snippet for that rank).
 */
export async function crawlMarkdown(url, { timeoutMs = 30000, pageTimeoutMs = 18000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE()}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [url],
        crawler_config: {
          type: 'CrawlerRunConfig',
          params: {
            page_timeout: pageTimeoutMs,
            wait_until: 'domcontentloaded', // don't wait for networkidle (ad/tracker tails)
            cache_mode: 'bypass', // we have our own disk cache upstream
            scan_full_page: false,
          },
        },
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const status = res.status === 403 || res.status === 401 ? 'blocked' : `http-${res.status}`;
      return { url, success: false, status, markdown: '', word_count: 0 };
    }
    const j = await res.json();
    const r = Array.isArray(j.results) ? j.results[0] : j;
    const md =
      r?.markdown?.fit_markdown ||
      r?.markdown?.raw_markdown ||
      (typeof r?.markdown === 'string' ? r.markdown : '') ||
      '';
    const wc = md ? md.split(/\s+/).filter(Boolean).length : 0;
    if (r && r.success === false && !md) {
      // distinguish a block/timeout from a generic miss where possible
      const reason = String(r.error_message || '').toLowerCase();
      const status = /403|forbidden|blocked|denied/.test(reason)
        ? 'blocked'
        : /timeout|timed out/.test(reason)
        ? 'timeout'
        : 'empty';
      return { url, success: false, status, markdown: '', word_count: 0 };
    }
    if (wc < 40) return { url, success: false, status: 'empty', markdown: md, word_count: wc };
    return { url, success: true, status: 'ok', markdown: md, word_count: wc };
  } catch (e) {
    const status = /abort|timed out/i.test(String(e.message)) ? 'timeout' : 'error';
    return { url, success: false, status, markdown: '', word_count: 0, error: String(e.message).slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}
