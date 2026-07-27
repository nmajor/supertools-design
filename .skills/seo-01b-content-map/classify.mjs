// Per-keyword classification for the content map. Pure, deterministic, testable.
// Given one seo-01 page target + the skill config, it decides:
//   - subject TOPIC (the cluster it belongs to)            -> assignTopic()
//   - the differentiating MODIFIER (color/season/style/...) -> differentiatorOf()
//   - whether it is a tool/FORMAT page (generator/quiz/...)  -> detectFormat()
//   - its FUNNEL stage (TOFU/MOFU/BOFU) via an ordered cascade -> classifyFunnel()
//   - its intent class, template, CTA strength, and the cannibalization
//     primary_intent_key = (intent_class, topic, differentiator).
// Grounded in docs/research/content-funnel-mapping.md §7.1 (the cascade),
// content-cannibalization.md §4/§7 (the keys), content-architecture-clusters.md §2.
//
// Matching is plural-aware (token-singularized) so "colors" matches the "color"
// signal, and the differentiator falls back to a RESIDUAL fingerprint (leftover
// content tokens) when no known subject modifier is present — this is what keeps
// semantically-distinct keywords from collapsing into one page (the over-merge
// bug a bare token-list match produces).

// crude singularizer: colors->color, dresses->dress, themes->theme, ideas->idea
const singular = (w) => w.replace(/ies$/, 'y').replace(/([^aeiou])es$/, '$1e').replace(/(\w{3,})s$/, '$1');
const tokens = (s) => String(s || '').toLowerCase().match(/[a-z]+/g) || [];
const singTokens = (s) => tokens(s).map(singular);
// normalized, singularized phrase (for multi-word signal matching)
const singStr = (s) => singTokens(s).join(' ');
// does the singularized keyword contain this signal phrase (also singularized)?
const phraseIn = (sStr, phrase) => {
  const p = singStr(phrase);
  return new RegExp(`(^| )${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(sStr);
};

// Verb/stopword leftovers that should NOT count as a differentiator.
const STOP = new Set([
  'wedding', 'weddings', 'for', 'a', 'an', 'the', 'your', 'my', 'and', 'with', 'to', 'of',
  'in', 'on', 'at', 'by', 'or', 'best', 'create', 'creating', 'make', 'making', 'choose',
  'choosing', 'pick', 'picking', 'find', 'finding', 'build', 'building', 'get', 'getting',
  'how', 'do', 'does', 'what', 'is', 'are', 'pinterest', 'diy',
].map(singular));

export const fitLevel = (b) => (b ? 'high' : 'low');

// --- BRAND/COMPETITOR detection: a keyword carrying a rival's brand token. Such
// targets are quarantined (never built, never a cluster anchor) — the project's
// hard no-competitor rule. Returns the matched token or null.
export function brandToken(keyword, cfg) {
  const s = singStr(keyword);
  return (cfg.brand_exclusions || []).find((b) => phraseIn(s, b)) || null;
}

// --- FORMAT detection: tool/quiz/generator words. Drive funnel+template, not topic.
export function detectFormat(keyword, cfg) {
  const s = singStr(keyword);
  const word = (cfg.format_modifiers || []).find((w) => phraseIn(s, w)) || null;
  return { isTool: !!word, formatWord: word };
}

// --- MODIFIER detection: the subject qualifier that makes a distinct spoke.
// Longest phrase first so "navy blue" beats "navy" and "dusty blue" beats "blue".
export function detectModifier(keyword, cfg) {
  const s = singStr(keyword);
  let best = null;
  for (const [cls, list] of Object.entries(cfg.modifier_sets || {})) {
    for (const m of list) {
      if (phraseIn(s, m) && (!best || m.length > best.value.length)) best = { value: m, modClass: cls };
    }
  }
  return best || { value: '', modClass: null };
}

// --- TOPIC assignment by subject signal tokens (format words stripped first).
// Returns the best-matching topic id, or 'other' (unmapped bucket).
export function assignTopic(keyword, cfg) {
  let s = singStr(keyword);
  for (const w of cfg.format_modifiers || []) s = s.replace(new RegExp(`(^| )${singStr(w)}( |$)`, 'g'), ' ');
  s = s.replace(/\s+/g, ' ').trim();
  let best = null;
  for (const t of cfg.topics) {
    let local = 0;
    for (const tok of t.signal_tokens) if (phraseIn(s, tok)) local = Math.max(local, tok.length);
    if (local && (!best || local > best.score)) best = { id: t.id, score: local };
  }
  return best ? best.id : 'other';
}

// --- INTENT class straight from DataForSEO's SERP-derived intent.
export function intentClass(dfsIntent) {
  return ['informational', 'commercial', 'transactional', 'navigational'].includes(dfsIntent)
    ? dfsIntent : 'informational';
}

// --- FUNNEL cascade (funnel research §7.1). Ordered, first match wins.
export function classifyFunnel(t, { isTool }, cfg) {
  const s = singStr(t.keyword);
  const fit = fitLevel(t.product_fit);
  const fw = cfg.funnel_words;
  const hit = (list) => list.find((w) => phraseIn(s, w));

  if (t.dfs_intent === 'transactional') return mk('BOFU', 'high', 'transactional intent');
  if (isTool) return mk('BOFU', 'high', `tool/format word "${isTool}"`);
  const bw = hit(fw.bofu);
  if (bw) return mk('BOFU', 'high', `BOFU modifier "${bw}"`);
  if (t.dfs_intent === 'navigational') return mk('BOFU', 'med', 'navigational intent');
  if (t.pillar === 'comparison') return mk('BOFU', 'high', 'comparison pillar');
  if (t.dfs_intent === 'commercial') {
    return fit === 'high' || fit === 'medium'
      ? mk('BOFU', 'med', 'commercial investigation + high product_fit')
      : mk('MOFU', 'med', 'commercial investigation + low product_fit');
  }
  const mw = hit(fw.mofu);
  if (mw) return mk('MOFU', 'med', `MOFU modifier "${mw}"`);
  const tw = hit(fw.tofu);
  if (tw) return mk('TOFU', 'high', `TOFU modifier "${tw}"`);
  if (t.pillar === 'jtbd') return mk('MOFU', 'low', 'jtbd pillar default');
  return mk('TOFU', 'low', 'category/informational default (inspiration)');

  function mk(stage, confidence, reason) { return { stage, confidence, reason }; }
}

// --- TEMPLATE + CTA from stage/topic (funnel research §2; playbook §6).
export function templateFor(stage, isTool, pillar) {
  if (isTool) return 'tool';
  if (pillar === 'comparison') return 'comparison';
  if (stage === 'BOFU') return 'category';
  if (stage === 'MOFU') return 'jtbd';
  return 'definition';
}
export const ctaStrength = (stage) =>
  stage === 'BOFU' ? 'primary-above-fold' : stage === 'MOFU' ? 'mid-page' : 'soft-contextual';

// --- The residual after stripping topic/format/goal/soft/stop words. Empty
// residual + no subject modifier == the bare HEAD term of the topic (the hub).
function residualTokens(keyword, topicId, cfg) {
  const topic = cfg.topics.find((t) => t.id === topicId);
  const strip = new Set([
    ...STOP,
    ...(cfg.soft_modifiers || []).map(singular),
    ...(cfg.format_modifiers || []).flatMap((w) => singTokens(w)),
    ...((cfg.goal_synonyms || {})[topicId] || []).flatMap((w) => singTokens(w)),
    ...(topic ? topic.signal_tokens.flatMap((w) => singTokens(w)) : []),
  ]);
  return singTokens(keyword).filter((tk) => !strip.has(tk));
}
export function isBareHead(keyword, topicId, cfg) {
  const mod = detectModifier(keyword, cfg);
  return !mod.value && residualTokens(keyword, topicId, cfg).length === 0;
}

// --- CANNIBALIZATION keys (cannibalization research §4/§7).
// differentiator = subject modifier if present, else the residual fingerprint.
// This keeps "dusty blue" spokes distinct (modifier), merges true synonyms
// (empty residual), and stops distinct-but-unlisted keywords from over-merging.
export function differentiatorOf(keyword, topicId, cfg) {
  const mod = detectModifier(keyword, cfg);
  if (mod.value) return { value: mod.value, modClass: mod.modClass };
  const resid = residualTokens(keyword, topicId, cfg);
  return { value: resid.sort().join(' '), modClass: resid.length ? 'residual' : null };
}
export function primaryIntentKey(intentCls, topicId, differentiator) {
  return `${intentCls}::${topicId}::${differentiator || ''}`;
}
