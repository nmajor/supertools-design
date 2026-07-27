---
name: seo-04-page-build
description: Generate a real, build-safe compact page from a seo-02 brief. The LLM drafts content only (sanitized semantic HTML + structured FAQ/steps/meta); a deterministic template renders the TanStack route + HowTo/FAQ JSON-LD + quiz CTA, wired to the app's design tokens. Writes src/routes/guides/<slug>.tsx and the compact-pages registry.
---

# seo-03 — Page Build

Third skill in the `seo-*` series. Consumes `page-briefs@1` from
`seo-02-serp-briefs`; produces `compact-pages@1` + an actual route file.

## Staged generation (not one-shot)

The body is written by a research-backed **chain**, not a single prompt (a
one-shot mega-prompt's *final* output only matches a chain's *first draft*). See
`docs/seo/content-voice-guide.md` + the three `docs/research/content-*.md` notes.

1. **Grounding pack** — brief + sources + PAA + novel facts in XML, prepended to every stage.
2. **Angle + gated outline** with per-section **word budgets** (the only length control that works — LLMs count tokens, not words).
3. **Section-by-section drafting** — grounded, answer-first, in-voice, citing `<novel_facts>` inline with their real source URLs.
4. **Length expand** if under the band (programmatic word count, not self-report).
5. **Self-critique → revise** against a rubric (capped).
6. **Humanize** — sentence-rhythm variation, de-AI'd phrasing, intro rewritten; then a **deterministic scrub** of any banned word/construction the lint still finds.
7. **Meta / lede / FAQ / steps / sources** derived from the final body.

**Voice** (skill config → `voice`, applied via `voice.mjs`): persona +
real brand exemplars (few-shot) + a banned-lexicon + a self-critique rubric. The
verifier enforces **0 AI tells** (banned words / "It's not just X, it's Y", etc.).

**Source linking** (per the research): inline citations + a Sources block, capped
at 2 links/URL (no link dumps), **dofollow** editorial citations (not nofollow),
`target="_blank" rel="noopener"`. The verifier enforces dofollow.

## Why content-only generation

The LLM emits **content** (HTML body + structured `faq`/`steps`/`meta`/`sources`)
— never JSX. A deterministic template renders the TSX, so a bad generation can't
break the build. `body_html` is sanitized (strip `<script>`/`<style>`/`on*`/
`class`/`style`/`javascript:` + markdown code fences) before it's embedded.

## What the rendered page has

- App-native layout (`prose prose-stone`, Fraunces headings, rose CTA) inside the
  existing AppShell.
- SEO head: `<title>`, meta description, canonical, og:* (`article`).
- **JSON-LD**: `HowTo` (from `how_to_steps`) or `Article`, plus `FAQPage`.
- Two **"Take the 60-second quiz"** CTAs (hero + closing band) wired to `/quiz`
  with an analytics event.
- The seo-02 unique angles woven in **with their citation links**, and a Sources
  list. (Cited claims are unverified leads — edit before launch.)
- **Inline hex colors → swatch chips**: any `#RRGGBB`/`#RGB` in the body renders
  as an inline chip (color dot + the hex in mono) that copies the hex on click,
  while the hex stays as real selectable text. This is automatic — the template
  wraps `BODY_HTML` with `withColorChips()` and wires `useHexCopy()` from
  `src/lib/color-chips`. Only text is transformed; markup/attributes are skipped.

## Steps

```sh
node .skills/seo-04-page-build/setup.mjs --only "how to make a wedding mood board"
# or --slug <slug>, or no arg for the first brief

node .skills/seo-04-page-build/verify.mjs

# preview locally (page is generated on a branch — review before publishing):
npm run dev   # then open http://localhost:3000/guides/<slug>
```

## Output

- `src/routes/guides/<slug>.tsx` — the route (TanStack picks it up via routeTree).
- `.supertools-state/seo-04-page-build/pages.json` — `compact-pages@1` registry
  (accumulates across runs).
- `.supertools-state/seo-04-page-build/content-<slug>.json` — raw generated
  content (for re-render / audit).
- `.supertools-state/seo-04-page-build.json` — receipt (records the upstream hash).

## Config

Skill config: `site_origin`, `routes_dir`, `route_base`, `org` (for
schema), and the product/brand block injected into the generation prompt.

## Guardrails

- Never publishes live — writes a route file for local preview; deploy is a
  separate, explicit step.
- Sanitizes model HTML; renders schema from structured fields (not model JSON-LD).
- The page must genuinely help even if the reader never buys (playbook §6.4).

## Common failure modes

| Symptom | Fix |
|---|---|
| `Upstream "seo-02-…" has not run` | Run seo-02 first (provides `page-briefs`). |
| Route 404 in dev | The dev server regenerates `routeTree.gen.ts` on start; restart `npm run dev`. |
| Body shorter than target | gpt-4o sometimes under-produces vs `word_count_target`; re-run or edit. Tune the prompt's length instruction. |
| Page reads thin/generic | Edit the brief (seo-02) — better gaps/angles produce a better page. Garbage in, garbage out. |
