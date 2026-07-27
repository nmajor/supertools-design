// DataForSEO client for the SEO skills.
//
// Two transports, auto-selected:
//   1. MCP (preferred) — a local DataForSEO MCP server (streamable-HTTP,
//      stateless) reachable at DATAFORSEO_MCP_URL. The server holds the
//      provisioned DataForSEO account, so it works even when the raw REST
//      account lacks Labs access. This is the working path in this project.
//   2. REST fallback — direct https://api.dataforseo.com basic-auth with
//      DATAFORSEO_USERNAME / DATAFORSEO_PASSWORD, for portability to a
//      checkout where the MCP server isn't running.
//
// Both expose the same surface: call a DataForSEO Labs / keywords_data / serp
// tool and get back the per-task `result` object ({ id, status_code, items }).
//
// Credentials come from process.env (general env vars OR .env via loadEnv()).

const MCP_URL = () => process.env.DATAFORSEO_MCP_URL;

// The DataForSEO MCP server's streamable-HTTP endpoint is /mcp. The configured
// URL sometimes points at the origin root, so normalize to /mcp when no
// meaningful path is given (but respect an explicit path if one is set).
function mcpEndpoint() {
  const u = new URL(MCP_URL());
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/mcp';
  return u.toString();
}
const REST_USER = () => process.env.DATAFORSEO_USERNAME;
const REST_PASS = () => process.env.DATAFORSEO_PASSWORD;

export function dfsTransport() {
  if (MCP_URL()) return 'mcp';
  if (REST_USER() && REST_PASS()) return 'rest';
  return null;
}

export function assertDfsCredentials() {
  if (!dfsTransport()) {
    throw new Error(
      'No DataForSEO transport available. Set DATAFORSEO_MCP_URL (preferred) ' +
        'or DATAFORSEO_USERNAME + DATAFORSEO_PASSWORD.'
    );
  }
}

// Map MCP tool names -> REST endpoint paths, for the fallback transport.
// MCP arguments are flat ({ keywords, location_name, language_code, ... });
// REST wants an array-of-tasks body, so the fallback re-shapes the args.
const REST_PATHS = {
  dataforseo_labs_google_keyword_overview: '/v3/dataforseo_labs/google/keyword_overview/live',
  dataforseo_labs_google_keyword_suggestions: '/v3/dataforseo_labs/google/keyword_suggestions/live',
  dataforseo_labs_google_keyword_ideas: '/v3/dataforseo_labs/google/keyword_ideas/live',
  dataforseo_labs_google_related_keywords: '/v3/dataforseo_labs/google/related_keywords/live',
  dataforseo_labs_bulk_keyword_difficulty: '/v3/dataforseo_labs/google/bulk_keyword_difficulty/live',
  dataforseo_labs_search_intent: '/v3/dataforseo_labs/google/search_intent/live',
  serp_organic_live_advanced: '/v3/serp/google/organic/live/advanced',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Parse a streamable-HTTP / SSE body: collect every `data:` payload, find the
// JSON-RPC envelope, then unwrap result.content[<first text>].text -> JSON.
function parseMcpBody(text) {
  const dataLines = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  let envelope = null;
  for (const d of dataLines) {
    try {
      const obj = JSON.parse(d);
      if (obj && (obj.result || obj.error)) {
        envelope = obj;
        break;
      }
    } catch {
      /* skip non-JSON keepalives */
    }
  }
  if (!envelope) {
    // Some deployments answer application/json (not SSE) — try the whole body.
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`MCP response not parseable: ${text.slice(0, 300)}`);
    }
  }
  if (envelope.error) {
    throw new Error(`MCP error: ${JSON.stringify(envelope.error).slice(0, 400)}`);
  }
  const content = envelope.result?.content || [];
  const textPart = content.find((c) => c.type === 'text');
  if (!textPart) {
    throw new Error(`MCP result has no text content: ${JSON.stringify(envelope.result).slice(0, 300)}`);
  }
  if (envelope.result.isError) {
    throw new Error(`DataForSEO API error: ${textPart.text.trim().slice(0, 400)}`);
  }
  let inner;
  try {
    inner = JSON.parse(textPart.text);
  } catch {
    // The MCP server sometimes returns API-level errors as a plain-text payload
    // (e.g. "Error: API Error: ... duplicate task limit ... (Code: 40205)")
    // rather than JSON. Surface those as clean API errors so callers can
    // classify them (rate limit vs auth vs bad input).
    const t = textPart.text.trim();
    if (/error|exceeded|limit|not authorized|code:\s*\d/i.test(t)) {
      throw new Error(`DataForSEO API error: ${t.slice(0, 400)}`);
    }
    throw new Error(`MCP tool text not JSON: ${t.slice(0, 300)}`);
  }
  return inner;
}

async function mcpRequest(toolName, args, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(mcpEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: ac.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${body.slice(0, 300)}`);
    return parseMcpBody(body);
  } finally {
    clearTimeout(t);
  }
}

async function restRequest(toolName, args, timeoutMs) {
  const path = REST_PATHS[toolName];
  if (!path) throw new Error(`No REST mapping for tool ${toolName}`);
  // Re-shape flat MCP args -> REST task. location_name -> location_name works
  // on REST too; everything else passes through inside the single task object.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const auth = Buffer.from(`${REST_USER()}:${REST_PASS()}`).toString('base64');
    const res = await fetch(`https://api.dataforseo.com${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify([args]),
      signal: ac.signal,
    });
    const env = await res.json();
    if (env.status_code !== 20000) {
      throw new Error(`REST ${env.status_code}: ${env.status_message}`);
    }
    const task = env.tasks?.[0];
    if (!task || task.status_code !== 20000) {
      throw new Error(`REST task ${task?.status_code}: ${task?.status_message}`);
    }
    return task.result?.[0] ?? { items: [] };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Call a DataForSEO tool. Returns the per-task result object
 * ({ id, status_code, status_message, items, ... }).
 *
 * Retries transient failures (network, timeout, 5xx, rate-limit) with backoff.
 * Throws on hard errors (auth, bad request) and after exhausting retries.
 */
export async function dfsCall(toolName, args, { retries = 3, timeoutMs = 120000 } = {}) {
  assertDfsCredentials();
  const transport = dfsTransport();
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result =
        transport === 'mcp'
          ? await mcpRequest(toolName, args, timeoutMs)
          : await restRequest(toolName, args, timeoutMs);
      if (result && typeof result.status_code === 'number' && result.status_code !== 20000) {
        // Task-level non-OK (e.g. 40501 invalid field). Don't retry bad input.
        throw new Error(`DataForSEO ${toolName} task ${result.status_code}: ${result.status_message}`);
      }
      return result;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const retryable =
        /abort|timed out|fetch failed|ECONN|ETIMEDOUT|socket|HTTP 5\d\d|rate.?limit|40202|too many/i.test(msg);
      if (attempt < retries && retryable) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw new Error(`DataForSEO ${toolName} failed (${transport}): ${msg}`);
    }
  }
  throw lastErr;
}

// Convenience: return just the items array (most endpoints).
export async function dfsItems(toolName, args, opts) {
  const r = await dfsCall(toolName, args, opts);
  return Array.isArray(r?.items) ? r.items : [];
}
