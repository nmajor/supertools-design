// Perplexity client — web-grounded research with citations.
// Used by seo-02 for the differentiation pass (find novel, fact-based, CITED
// info to add beyond the top-10). Needs PERPLEXITY_API_KEY.
//
// Returns { content, citations[], search_results[], cost, model } — always with
// the citations so downstream can flag claims for verification (never publish an
// unsourced fact). Pure call; caching is the caller's job.

const ENDPOINT = 'https://api.perplexity.ai/chat/completions';

export function perplexityConfigured() {
  return !!process.env.PERPLEXITY_API_KEY;
}

export async function perplexityResearch(
  prompt,
  { model = 'sonar', system, timeoutMs = 60000, searchRecency } = {}
) {
  if (!perplexityConfigured()) throw new Error('PERPLEXITY_API_KEY not set');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        ...(searchRecency ? { search_recency_filter: searchRecency } : {}),
      }),
      signal: ac.signal,
    });
    const j = await res.json();
    if (!res.ok) {
      throw new Error(`Perplexity ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    }
    return {
      content: j.choices?.[0]?.message?.content || '',
      citations: j.citations || [],
      search_results: j.search_results || [],
      cost: j.usage?.cost?.total_cost ?? null,
      model: j.model || model,
    };
  } finally {
    clearTimeout(t);
  }
}
