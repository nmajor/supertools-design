// Content voice — the PROMPT side only (what the model is told). The
// deterministic copy layer (cleanCopy + lintTells) lives in _shared/copy.mjs.
// Voice DATA is the skill config ("voice" key); this turns it into a system
// prompt + the self-critique rubric. Grounded in docs/seo/content-voice-guide.md.

export function voiceSystem(voice) {
  const exemplars = (voice.exemplars || []).map((e, i) => `  ${i + 1}. ${e}`).join('\n');
  return `VOICE: write as ${voice.persona}

HOW IT SHOULD FEEL:
${(voice.feel || []).map((f) => `- ${f}`).join('\n')}

STRUCTURE: ${voice.structure}

SENTENCE-LEVEL: ${voice.sentence_level}

THESE ARE OUR VOICE (match their specificity, confidence, and rhythm; do NOT copy their content):
${exemplars}

NEVER use these words/phrases (AI tells): ${(voice.banned || []).join(', ')}.
NEVER use these constructions: ${(voice.banned_constructions || []).join('; ')}.
NEVER use an em dash or en dash (the "—" or "–" character): it is the #1 AI tell. Use a comma, a period, or parentheses instead; for number ranges write "to". (Ordinary hyphens in compound words like "60-second" are fine.) Use straight quotes and apostrophes, never curly ones. No emoji.

NEVER do these (structural AI tells):
- No negative parallelism in any form: "It's not X, it's Y", "not about A, but B", "less X, more Y".
- No rule-of-three as a default rhythm. Group three things only when three is genuinely the count; never stack triplets in consecutive sentences or paragraphs.
- No "Bold Header: description" listicle skeleton, no hook-then-bullets-then-tidy-conclusion shape, no bolding words inside paragraphs.
- No hedging or both-sides mush ("can be great, but also has challenges"). Take a side.
- No "Picture this:" or "Imagine a..." hypotheticals that fake experience. Use named, concrete, specific detail instead.
- No rhetorical-question fake hooks: "The best part?", "Here's the thing:", "Let's break it down:", "Sound familiar?".
- No restating: "In other words", "To put it simply", "What this means is".
- No grandiose metaphor-nouns for plain subjects (tapestry, landscape, realm, mosaic, symphony, beacon, cornerstone, journey, roadmap).
- No significance-inflation frames: "Despite its X, Y", "While X, it's also Y".
- No throat-clearing openers. No flattery the reader didn't earn. Headings in sentence case, not Title Case.`;
}

// The self-critique rubric (the critique stage). Anchored to brief + voice.
export const VOICE_RUBRIC = `Score each 1-5 and quote the offending text:
1. Intent match: answers the query the way searchers want, format matches the SERP.
2. Coverage: all assigned table-stakes sections, PAA gaps, and unique angles present.
3. Evidence: claims grounded; cited facts attributed; no invented stats.
4. Information gain: says something the top-10 don't (the unique angles are woven in, not bolted on).
5. Specificity: every paragraph names a concrete, this-aesthetic thing (a flower, fabric, hex, season), never generic.
6. Voice: confident POV, varied sentence length, zero banned words/constructions, no throat-clearing. Could this run on any wedding blog? If yes, it's not ours yet.
7. Structural tells: none of: negative parallelism, rule-of-three rhythm, "Bold Header: description" skeleton, rhetorical-question hooks, restating, grandiose metaphor-nouns, significance-inflation, hedging mush, fake "Picture this" hypotheticals, emoji, Title Case headings.
8. Answer-first openings: does the FIRST sentence of EACH section directly and completely answer its heading, with the heading's key term as the subject and NO hex codes, lists, examples, hooks, or preamble in that sentence? For a "What is X" heading, sentence 1 must plainly define X. Flag and rewrite any section that buries its answer (e.g. opens with color codes or scene-setting instead of the answer).`;
