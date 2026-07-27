// Deterministic copy layer — shared by any skill that emits user-facing text
// (seo-03 image alt/captions, seo-04 prose). Two responsibilities:
//   - cleanCopy(): the SOLE guarantee that the punctuation/typography AI tells are
//     zero (em/en/exotic dashes, curly quotes, emoji, ellipsis, arrows, invisible
//     chars). Idempotent; never touches ordinary hyphens in compounds.
//   - lintTells(): DETECT the rest — banned words, banned constructions, and the
//     regex-able structural "fake hook" phrases — for an LLM scrub pass and a
//     verify gate. (The full structural set lives in the voice system prompt.)
// Grounded in docs/research/ai-tells-guard.md (Section A) + content-voice-guide.md.

export const countWords = (html) =>
  String(html).replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

// Models sometimes wrap HTML in a ```html ... ``` markdown fence — strip it.
export const stripFence = (s) =>
  String(s).trim().replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

// The emoji range used by BOTH cleanCopy (strip) and lintTells (detect) — parity.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}✅✨❤⭐👉]/gu;

/**
 * Hard-kill the deterministic typography tells. Idempotent.
 */
export function cleanCopy(s) {
  return String(s)
    // number ranges with any dash -> "to"
    .replace(/(\d)\s*[—–―‒]\s*(\d)/g, '$1 to $2')
    .replace(/(\d) +- +(\d)/g, '$1 to $2')
    // any dash variant used as punctuation -> comma (drop when adjacent to a tag)
    .replace(/(>)\s*[—–―‒]\s*/g, '$1')
    .replace(/\s*[—–―‒]\s*(<)/g, '$1')
    .replace(/\s*[—–―‒]\s*/g, ', ')
    .replace(/ +- +/g, ', ') // spaced hyphen used as a dash (the AI "overcorrection")
    // curly quotes / apostrophes -> straight
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    // fancy ellipsis -> ..., arrows removed, emoji removed, odd-width chars normalized
    .replace(/…/g, '...')
    .replace(/[→➔➜➡⮕]/g, '')
    .replace(EMOJI, '')
    .replace(/[   ]/g, ' ')
    .replace(/[​‌‍﻿]/g, '')
    // cleanup
    .replace(/ {2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ', ')
    .replace(/,\s*([.!?;:])/g, '$1');
}

// Regex-able structural "fake hook" tells. The full semantic set (metaphor-nouns,
// significance-inflation, participial openers, Title Case...) is in the voice
// system prompt; these are the ones a regex can reliably catch for the scrub.
const PHRASE_TELLS = [
  [/\bhere'?s the (thing|kicker|deal|secret)\b/i, "here's the thing"],
  [/\bthe (best part|result|kicker|catch)\?/i, 'the best part?'],
  [/\blet'?s (break (it|this) down|dive in)\b/i, "let's break it down"],
  [/\bsound familiar\?/i, 'sound familiar?'],
  [/\bin other words\b/i, 'in other words'],
  [/\bto put it simply\b/i, 'to put it simply'],
  [/\bwhat this means is\b/i, 'what this means is'],
  [/\bpicture this\b/i, 'picture this'],
  [/\bless \w+, more \w+\b/i, 'less X, more Y'],
  [/\bdespite its \w+/i, 'despite its X'],
];

/**
 * Detect tells. `voice` supplies the banned lexicon + constructions.
 * Returns: banned[], constructions[], phrases[] (LLM-fixable, drive the scrub) and
 * emDashes/curlyQuotes/emoji counts (deterministic — cleanCopy guarantees these 0).
 */
export function lintTells(text, voice = {}) {
  const plain = String(text || '').replace(/<[^>]+>/g, ' ');
  const lower = plain.toLowerCase();
  const banned = (voice.banned || []).filter((w) => {
    const re = new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(lower);
  });
  const constructions = [];
  if (/\bit'?s not just\b[^.?!]*\bit'?s\b/i.test(plain)) constructions.push("it's not just X, it's Y");
  if (/\bnot (just )?about\b[^.?!]*\bbut\b/i.test(plain)) constructions.push('not about X, but Y');
  const phrases = PHRASE_TELLS.filter(([re]) => re.test(plain)).map(([, n]) => n);
  const words = plain.split(/\s+/).filter(Boolean).length || 1;
  const emDashes = (plain.match(/[—–―‒]/g) || []).length;
  const curlyQuotes = (plain.match(/[‘’“”]/g) || []).length;
  const emoji = (plain.match(EMOJI) || []).length;
  const emDashDensity = +(emDashes / (words / 100)).toFixed(2);
  const score =
    banned.length * 2 + constructions.length * 3 + phrases.length * 2 + (emDashes + curlyQuotes + emoji) * 3;
  return { banned, constructions, phrases, emDashes, curlyQuotes, emoji, emDashDensity, score };
}

// Buried-lede detector (per docs/research/answer-first-sections.md): each section
// should answer its heading in sentence 1. Cheap, deterministic heuristics flag a
// section whose opening sentence buries the answer; the result drives a targeted
// answer-first rewrite pass + a verify warning. Returns [{heading, reasons[]}].
const PREAMBLE =
  /\b(in this (article|guide|post|section)|before we (dive|begin|start)|let'?s (talk about|dive|explore)|many (couples|people|brides|readers) (wonder|ask|want)|these days|in today'?s)/i;
export function buriedLedes(html) {
  const out = [];
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>\s*(?:<h3[^>]*>[\s\S]*?<\/h3>\s*)?<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const heading = m[1].replace(/<[^>]+>/g, '').trim();
    const para = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const first = (para.match(/^.*?[.!?](\s|$)/) || [para])[0];
    const reasons = [];
    if (/#[0-9a-fA-F]{3,6}\b/.test(first)) reasons.push('hex code in sentence 1');
    if (PREAMBLE.test(first)) reasons.push('preamble in sentence 1');
    // A "What is X?" heading whose first sentence never says is/are/refers-to is not defining.
    if (/^what (is|are)\b/i.test(heading) && !/\b(is|are|refers to)\b/i.test(first)) {
      reasons.push('definition not led with');
    }
    if (reasons.length) out.push({ heading, reasons });
  }
  return out;
}
