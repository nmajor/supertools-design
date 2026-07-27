// seo-04 staged content pipeline — turns a brief into article copy via a chain
// (plan -> section drafts -> critique -> humanize -> scrub -> meta). A one-shot
// prompt's final output only matches a chain's first draft, so each stage is a
// focused pass. See docs/research/content-workflow-flows.md.
//
// Length discipline: there is NO word target/padding pass. Depth is matched to
// the SERP median (a *cue*, not a pad), and the critique/humanize/scrub passes
// run through ONE `revise()` wrapper that reverts any pass which drops >X% of the
// body — they are quality/phrasing passes, never trimming passes.
//
// Tell discipline: this pipeline only chases the LLM-fixable tells (banned words,
// constructions, structural phrases). The deterministic typography tells (dashes,
// curly quotes, emoji) are guaranteed zero by cleanCopy at the render boundary.

import { chat, chatJSON } from '../_shared/openai.mjs';
import { lintTells, buriedLedes, countWords, stripFence } from '../_shared/copy.mjs';
import { voiceSystem, VOICE_RUBRIC } from './voice.mjs';

const chatHtml = async (p, o) => stripFence(await chat(p, o));

// Role-based SCOPE directive (from the content-map handoff). A HUB is a broad
// pillar that must survey the whole category; a SPOKE stays tight on its one
// differentiator. Without this, the drafter narrows a broad hub like "wedding
// color palette" down to a single instance ("spring..."), which mis-serves the
// head term AND cannibalizes the real spoke.
export function scopeDirective(brief) {
  const kw = brief.primary_keyword;
  const diff = brief.differentiator;
  if (brief.role === 'hub') {
    return `<scope>
  PAGE TYPE: HUB / pillar for the BROAD topic "${kw}".
  Cover the ENTIRE category at survey breadth: span the full range of options (across seasons, color families, styles, and budgets as relevant). Do NOT narrow the article, the H1, or the meta title to a single season/color/instance ("spring...", "dusty blue...") — the reader wants the whole landscape here, then links out to the specifics. The H1 and title use the broad term itself.
</scope>`;
  }
  if (brief.role === 'spoke' && diff) {
    return `<scope>
  PAGE TYPE: SPOKE focused tightly on "${diff}" within "${kw}".
  Go deep on ${diff} with named, concrete detail. Do NOT drift up into the broad category or cover sibling variants — those are separate pages. The H1 and title name ${diff} specifically.
</scope>`;
  }
  return '';
}

function buildGroundingPack(brief, cfg) {
  const b = brief.brief;
  const facts = (brief.unique_angles || [])
    .map((a, i) => `  <fact index="${i + 1}" source="${a.source_url}"${a.needs_verification ? ' verify="true"' : ''}>${a.insight}</fact>`)
    .join('\n');
  const paa = [...new Set([...(b.paa_gaps_to_win || []), ...(brief.serp?.people_also_ask || [])])];
  const scope = scopeDirective(brief);
  return `<brief>
  keyword: ${brief.primary_keyword}
  also rank for: ${(brief.variants || []).join(', ') || 'n/a'}
  search intent: ${brief.intent}; SERP format to match: ${b.recommended_format}
  audience: engaged couples planning a wedding (22-38, heavy Pinterest planners)
  product: ${cfg.product.name}, ${cfg.product.what}
  brand rules: ${cfg.product.brand_constraints.join(' ')}
</brief>${scope ? '\n' + scope : ''}
<table_stakes>${b.table_stakes_h2.map((h) => `\n  - ${h}`).join('')}
</table_stakes>
<gaps>${(b.gaps || []).map((g) => `\n  - ${g}`).join('') || '\n  - (none)'}
</gaps>
<paa>${paa.map((q) => `\n  - ${q}`).join('') || '\n  - (none)'}
</paa>
<novel_facts>
${facts || '  (none, do not invent any)'}
</novel_facts>`;
}

// The ONE length-preservation wrapper for the editing passes.
async function revise(body, fn, { minRatio, label, log }) {
  const out = stripFence(await fn(body));
  if (out && countWords(out) >= countWords(body) * minRatio) return out;
  log(`  ${label} cut ${countWords(body)} -> ${countWords(out)}w; kept prior (editing passes must not lose content)`);
  return body;
}

/**
 * Generate article content. Returns { content, plan }. `content.body_html` still
 * contains the raw body (the orchestrator runs cleanCopy + link processing).
 */
export async function generateContent({ brief, cfg, log = console.log }) {
  const D = cfg.drafting;
  const VOICE = voiceSystem(cfg.voice);
  const grounding = buildGroundingPack(brief, cfg);
  const target = brief.brief.word_count_target || 1500;

  // Stage 1+2 — angle/POV + outline, depth-matched to the SERP.
  log('stage 1-2: angle + outline');
  const plan = await chatJSON(
    `${grounding}

You are an SEO content architect. Decide the angle, then the outline. Output NO body prose.
1. consensus: 3 bullets, what the current top-10 all say.
2. information_gain: 1-3 things THIS page will own that the consensus misses (use <novel_facts>, a sharper POV, or a better structure).
3. thesis: 2-3 sentences, the single promise of the article.
4. outline: ordered H2 sections (optional H3s) that satisfy ${brief.intent} intent in the format "${brief.brief.recommended_format}". DEPTH MATTERS: the pages currently ranking for this query average about ${target} words across many substantive sections, so readers (and Google) expect a thorough, best-on-the-web guide here. Plan enough sections, and rich enough ones, to match that depth while adding our unique angles. Cover every table-stakes topic, every PAA gap, and the unique angles. This is not a "tight compact page", it is a complete guide. Cut only true filler; do not under-build. No rigid word budget, but aim in the ballpark of the ranking pages' depth.

Return JSON: { "consensus": [], "information_gain": [], "thesis": "", "outline": [ { "h2": "", "h3s": [], "subquestion": "", "covers": [] } ] }`,
    { system: 'You return only valid JSON.', temperature: D.edit_temperature }
  );
  const outline = Array.isArray(plan.outline) && plan.outline.length ? plan.outline : [];
  log(`  ${outline.length} sections (SERP depth ~${target}w)`);

  // Stage 3 — section-by-section drafting.
  log('stage 3: section drafting');
  const sections = [];
  for (const s of outline) {
    const html = await chatHtml(
      `${grounding}

THESIS: ${plan.thesis}

Write ONLY this one section as clean semantic HTML: an <h2> heading then <p>/<ul>/<ol>/<strong>/<a href>. No <h1>, no class/style, no <script>.
Section heading: ${s.h2}${s.h3s?.length ? ` (subheads: ${s.h3s.join(', ')})` : ''}

ANSWER-FIRST (the most important rule). Your FIRST SENTENCE must directly and completely answer the heading, in plain language, with the heading's key term as the subject. A reader who reads ONLY that sentence has the answer. Then, in the sentences AFTER, add the depth, specifics, and named examples. Match sentence 1 to the heading type:
- "What is X?" -> define it plainly: "X is a [category] that [does/contains ...]." No opinion, no hook, no color codes in that sentence.
- "How to / How do you X?" -> state the action or whole process in one line, then an ordered <ol> of the steps.
- "Why X / Benefits of X" -> state the single main benefit outright.
- "Best / Types of X" -> name the items in sentence 1, then elaborate each in the same order.
- "When / Where / How much / How long" -> give the concrete value first.
NEVER put in the first sentence: a hex color code, a list, a specific example or tip, a hook or rhetorical question, "imagine/picture this", or preamble ("In this article", "Many couples", "Before we dive in"). Those belong in sentences 2+.

BAD opening (buries the answer, do NOT do this): "Dusty rose (#DCAE96) with eucalyptus and gold creates a refined vibe. Add silk and lace. Your mood board should capture this."
GOOD opening (answers first): "A wedding mood board is a curated collection of color swatches, fabric textures, flowers, and inspiration photos that captures the look and feeling you want for your day." -> then specifics, palettes, examples.

Must cover (across the section, AFTER the opening answer): ${(s.covers || []).join('; ') || '(the heading topic)'}. Also answer the implied sub-question: ${s.subquestion}.
After the opening answer, go DEEP and concrete: name specific flowers, fabrics, hex colors, tools, common mistakes, vendor tips. Match the depth of the ranking pages, in tight sentences with no filler, a complete guide and not a summary.

Rules:
- When you use a <novel_facts> item, you MUST cite it inline with its real source from that fact's source="..." attribute: <a href="THAT-EXACT-URL">a descriptive anchor</a>. Keep the literal URL, this is a real citation, not a placeholder. Never invent statistics; if a needed fact isn't provided, make the point without a number.
- Continue the established VOICE, but the FIRST sentence stays plain and answer-first; voice flourishes come after. Don't re-introduce the whole topic or repeat other sections.
Output the section HTML only.`,
      { system: VOICE, temperature: D.draft_temperature }
    );
    sections.push(html);
  }
  let body = sections.join('\n\n');
  log(`  drafted ${sections.length} sections, ${countWords(body)} words`);

  // Stage 4 — self-critique then revise (length-guarded, capped).
  for (let r = 0; r < D.max_critique_rounds; r++) {
    log(`stage 4: critique/revise (round ${r + 1})`);
    body = await revise(
      body,
      async (b) => {
        const cr = await chatJSON(
          `${grounding}

You are a ruthless managing editor. Critique the draft against the rubric, then return a revised version.
${VOICE_RUBRIC}

DRAFT:
${b}

Return JSON: { "critique": "scores 1-5 per rubric item + concrete weaknesses with quoted offending text + the fix", "revised_html": "the FULL revised article body as HTML, all headings/links preserved, same or better length, every weakness fixed" }`,
          { system: VOICE, temperature: D.edit_temperature }
        );
        return cr.revised_html || b;
      },
      { minRatio: D.critique_min_ratio, label: 'critique', log }
    );
  }

  // Stage 6 — humanize / voice pass (rhythm + de-AI; length-guarded).
  log('stage 6: humanize');
  body = await revise(
    body,
    (b) =>
      chatHtml(
        `Rewrite the article body to read like an experienced human wrote it, WITHOUT changing facts, claims, headings, links, or keyword coverage.
- Vary sentence length deliberately: mix sentences under six words with long winding ones; never three similar-length sentences in a row.
- Rewrite the first 1-2 sentences of the whole article from scratch so it opens on something concrete, not a definition.
- Tighten WORDY SENTENCES (cut hedging and filler, prefer the shorter phrasing, say it once), but KEEP every point, step, fact, section, and heading. This pass changes phrasing only, never coverage. Do NOT shorten the article overall or drop content.
- Keep it HTML (same tags), keep every <a href> link exactly.

${b}

Output the rewritten HTML body only.`,
        { system: VOICE, temperature: D.draft_temperature }
      ),
    { minRatio: D.humanize_min_ratio, label: 'humanize', log }
  );

  // Stage 6b — scrub the LLM-fixable tells (banned/constructions/phrases). The
  // deterministic typography tells are handled by cleanCopy at the boundary, so
  // they are NOT in this loop. Capped at 2 rounds, length-guarded.
  for (let r = 0; r < 2; r++) {
    const leak = lintTells(body, cfg.voice);
    const tells = [...leak.banned, ...leak.constructions, ...leak.phrases];
    if (!tells.length) break;
    log(`stage 6b (round ${r + 1}): ${leak.banned.length} banned, ${leak.constructions.length} constructions, ${leak.phrases.length} phrases`);
    body = await revise(
      body,
      (b) =>
        chatHtml(
          `Fix the HTML below by rephrasing minimally in our voice. Keep ALL content, headings, links, and facts, only rephrase to remove these tells:
${tells.map((t) => `- Remove / rewrite around: "${t}"`).join('\n')}

${b}

Output the full HTML body only, same length.`,
          { system: VOICE, temperature: D.edit_temperature }
        ),
      { minRatio: D.scrub_min_ratio, label: `scrub r${r + 1}`, log }
    );
  }

  // Stage 6c — answer-first backstop: deterministically detect sections that bury
  // the answer (hex code / preamble in sentence 1, or a "What is X" that never
  // defines), then rewrite ONLY those opening sentences to lead with the answer.
  const buried = buriedLedes(body);
  if (buried.length) {
    log(`stage 6c: ${buried.length} buried-lede section(s): ${buried.map((b) => b.heading).join('; ')}`);
    body = await revise(
      body,
      (b) =>
        chatHtml(
          `In the HTML below, rewrite ONLY the FIRST sentence of each listed section so it directly and completely answers the heading in plain language: the heading's key term is the subject, and the sentence has NO hex codes, lists, examples, hooks, or preamble. For a "What is X" heading, sentence 1 must plainly define X ("X is a [category] that ..."). Keep everything else in the article exactly as-is. Sections to fix:
${buried.map((b) => `- "${b.heading}" (${b.reasons.join(', ')})`).join('\n')}

${b}

Output the full HTML body only.`,
          { system: VOICE, temperature: D.edit_temperature }
        ),
      { minRatio: 0.9, label: 'answer-first', log }
    );
  }

  // Stage 7 — meta / lede / faq / steps / sources / CTA from the FINAL body.
  log('stage 7: meta + faq + lede');
  const meta = await chatJSON(
    `Using the FINAL article body below, produce metadata. Stay in VOICE for prose fields.
KEYWORD: ${brief.primary_keyword}${brief.role === 'hub' ? `\nSCOPE: this is a BROAD hub page — the meta_title and h1 MUST use the broad keyword "${brief.primary_keyword}" as-is; do NOT narrow them to one season/color/instance.` : ''}${brief.role === 'spoke' && brief.differentiator ? `\nSCOPE: this is a spoke — the meta_title and h1 name "${brief.differentiator}" specifically.` : ''}
BODY:
${body}

Return JSON:
{
  "meta_title": "<= 60 chars, keyword near the front, compelling, not clickbait",
  "meta_description": "<= 155 chars, keyword + the real payoff",
  "h1": "the on-page H1 (keyword or close variant)",
  "lede": "1-2 sentences that DIRECTLY answer the query in the first 40-60 words (front-loaded for snippets + AI Overviews), plain text, in voice",
  "how_to_steps": [ { "name": "", "text": "" } ],
  "faq": [ { "q": "", "a": "concise answer drawn from the body" } ],
  "sources": [ { "label": "", "url": "https://..." } ],
  "closing_cta_heading": "",
  "closing_cta_text": "1-2 sentences, in voice, inviting the quiz"
}
Rules: how_to_steps mirror the steps actually in the body (empty array if it isn't a how-to). faq = only PAA-style questions the body answers. sources = ONLY the outbound URLs that actually appear as <a href> in the body. Do not invent anything not in the body.`,
    { system: VOICE, temperature: 0.4 }
  );

  return { content: { ...meta, body_html: body }, plan, target };
}
