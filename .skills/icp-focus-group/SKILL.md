---
name: icp-focus-group
description: Run a 3-model ICP focus group — codex (gpt-5.5), gemini (2.5-pro), and claude each role-play an ideal-customer persona and assess an artifact (image, page, copy, feature, anything). Answers are quantified (scored on defined scales) so verdicts can be aggregated and compared across models.
---

# ICP focus group (meta-skill)

Get a fast, model-diverse read on "would a real target user find this good / useful / trustworthy?" — by having **three different LLM backends** each role-play your ideal customer profile (ICP) and score the thing on scales you define. Three independent models reduce single-model bias; the quantified format lets you aggregate (mean/range) and spot disagreement instead of reading three blobs of prose.

Use it for anything assessable: a rendered UI/mockup image, a landing page, marketing copy, a pricing idea, a feature concept, a name, a screenshot of a competitor. It is **open-ended** — you supply the persona, the artifact, and the questions.

## When to use

- You want honest "is this good / useful / worth it" feedback from a target user's POV before shipping or deciding.
- You want it scored, not vibes — so you can compare options or track improvement across iterations.
- A single model's opinion isn't enough; you want cross-model corroboration.

Not for: factual correctness review (use `_collab-review` / a code review), or anything where there's a ground-truth answer rather than a subjective user judgment.

## Core principles

1. **Quantify everything.** Every question carries an explicit numeric scale (e.g. `1-10`, where you state what 1 and 10 mean). Each panelist must return a number per question + one overall score + a short verdict. Numbers make answers aggregatable and comparable across the 3 models and across iterations.
2. **Ask in a quantified, decision-useful way.** Phrase questions so the answer is a rating, not an essay: "Rate 1-10 how useful this is for planning your wedding (1 = useless, 10 = would use daily)" beats "Is this useful?". Always ask for a one-line rationale alongside the number so the score is interpretable.
3. **Stay in persona.** Each panelist is a *person* (the ICP), not an AI reviewer. Give a concrete persona (age, situation, savviness, skepticism, what they'd otherwise use). Same persona across all three models = a clean model-diversity test; different personas per model = a mini multi-segment panel.
4. **Model diversity is the point.** codex (gpt-5.5, high reasoning), gemini-2.5-pro, and claude each answer independently. Report all three + the aggregate; call out where they disagree (that's signal).

## Inputs (a config JSON)

```json
{
  "topic": "Wedding color palette generator — palette applied to real dress/suit/bouquet/table photos",
  "images": ["/abs/path/a.png", "/abs/path/b.png"],
  "persona": "28-year-old just-engaged woman planning her wedding; heavy Pinterest user, not a designer, budget-aware, a bit skeptical of gimmicks.",
  "questions": [
    { "id": "useful",   "text": "How useful is this for planning your wedding?", "scale": "1-10 (1=useless, 10=would use daily)" },
    { "id": "trust",    "text": "How much do you trust it given the flowers look a bit artificial?", "scale": "1-10 (1=looks fake/bounce, 10=fully trust)" },
    { "id": "vs_alts",  "text": "How much better is this than Pinterest / Coolors / The Knot?", "scale": "1-5 (1=worse, 3=same, 5=clearly better)" }
  ],
  "panelistPersonas": { "gemini": "optional per-model persona override", "codex": "...", "claude": "..." }
}
```

- `topic` (required): one line describing what's being assessed.
- `images` (optional): absolute paths. codex gets them via `-i`, gemini via `@path`, claude via its Read tool — all three see them.
- `persona` (required): the shared ICP. `panelistPersonas` optionally overrides per model.
- `questions` (required): each `{id, text, scale}`. State what the scale endpoints mean.

## Usage

```sh
node .claude/skills/icp-focus-group/run.mjs <config.json>
# example config provided:
node .claude/skills/icp-focus-group/run.mjs .claude/skills/icp-focus-group/example.config.json
```

Runs all three panelists in parallel (~30–120s). Writes to `.supertools-state/icp-focus-group/<timestamp>/`:
- `codex.log`, `gemini.log`, `claude.log` — each panelist's full in-character answer.
- `summary.json` — parsed per-question scores per panelist, plus aggregates (mean, min, max, range) and a `consensus` flag per question (range ≤ 2 on a 10-scale = consensus; wider = split).
- `report.md` — human-readable: the score table, per-question aggregates, and each verdict.

## How each panelist is invoked (validated patterns)

- **codex**: `codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.5 -c model_reasoning_effort=high -i <img>...` with the prompt on **stdin**. (Do NOT pass the prompt as a positional arg alongside `-i`: `-i` is variadic and will swallow it. stdin avoids that.)
- **gemini**: `gemini -m gemini-2.5-pro -y -p "<prompt with @/abs/img paths inline>"`.
- **claude**: `claude -p "<prompt that instructs: use the Read tool to view <paths> first>"` — claude reads the images via its tools.

Each prompt ends by requiring a strict final line `FOCUS_GROUP_JSON: {"scores":{...},"overall":N,"verdict":"..."}` which `run.mjs` parses; free-text above it is preserved in the log.

## Interpreting results

- **Aggregate, then read prose.** Lead with the mean overall + per-question means; the verdicts explain the why.
- **Disagreement is signal.** If one model scores 3 and two score 8, read that model's verdict — it often caught a real failure mode the others rationalized away.
- **Track across iterations.** Re-run the same config after a change; compare means to show the change helped (or didn't).
- These are simulated users, not real ones — treat as a fast directional gut-check / pre-test, not a substitute for real user testing on a high-stakes call.

## Extending

- Multi-segment panel: give each model a different `panelistPersonas` entry (e.g. budget bride, luxury planner, groom) for a cheap segment spread.
- A/B: run two configs (variant A images vs variant B) and diff the means.
- More than 3 voices: run the same config twice with different personas, or add more `images`/questions — the format scales.
