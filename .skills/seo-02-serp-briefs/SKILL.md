---
name: seo-02-serp-briefs
description: Turn keyword page-targets into research-grade content briefs. For each target it captures the full live SERP (DataForSEO), crawls the top-10 ranking bodies (Crawl4AI), runs People-Also-Ask gap analysis as the primary novelty signal, then Perplexity differentiation research for novel cited facts — and assembles a build brief that matches SERP intent while out-helping the current results.
---

# seo-02 — SERP Briefs

Second skill in the `seo-*` series. Produces `page-briefs@1` for `seo-03`/`seo-04`.

**Selection (preferred):** when `seo-01b-content-map` has run, seo-02 selects +
orders targets from its `content-map@1` `build_queue` (BOFU-first,
hub-before-spoke, **deduped** ~472 pages vs seo-01's 660) and enriches each brief
with `funnel_stage / template / cluster / url_path / differentiator / variants`.
Briefing the deduped set is the point — it stops seo-02 from briefing
near-duplicates that would cannibalize. It still reads `keyword-targets@1` for the
fallback order and to back-fill `pillar` by slug.

**Fallback:** if the content-map is absent, it falls back to seo-01's flat
`page_targets` order (with an `[INFO]` log) — never hard-fails.

This is the automated, deepened form of the playbook's most important production
step — §7.4 (SERP analysis), §7.3 (AI competitor extraction), §11.3 (GEO
original-value). See the full design in `docs/seo/seo-pipeline-spec.md` §4.2.

## Method (per target)

1. **Full SERP capture** — `serp_organic_live_advanced` (organic + ads + AI
   Overview + PAA-with-answers + related). The raw dump is saved for audit.
2. **Crawl the top-K organic bodies** — Crawl4AI → markdown; extract word count,
   H2 outline. Failures (blocked/timeout) degrade gracefully.
3. **LLM synthesis** (gpt-4o) — dominant format, `recommended_format` (must match
   what ranks), table-stakes H2s, gaps, H1, PAA→FAQ, schema type, word target.
4. **PAA-gap analysis — the primary novelty signal.** Each PAA question is scored
   against how well the crawled top-10 answer it; relevant + under-answered =
   `opportunity` (snippet/AI-citation wedge). These seed step 5.
5. **Perplexity differentiation** — seeded by the under-answered PAA, finds
   novel, **cited**, fact-based angles; an LLM filters to those genuinely absent
   from the top-10 and fitting the product. *Never forced* — zero is valid.
6. **Assemble the brief** + persist all raw evidence.

## Dependencies

- `seo-01-keyword-discovery` must have run (provides `keyword-targets`).
- `seo-01b-content-map` **recommended** (provides `content-map` — cannibalization-safe
  selection/order/enrichment). Optional: absent → flat fallback.
- DataForSEO transport (`DATAFORSEO_MCP_URL` or REST) — `_shared/dataforseo.mjs`.
- **Crawl4AI** at `CRAWL4AI_URL` (default `http://localhost:11235`).
- **`PERPLEXITY_API_KEY`** (differentiation) and **`OPENAI_API_KEY`** (synthesis).

## Steps

```sh
# preview the resolved, ordered selection — NO API calls, exits 0 (free test):
node .skills/seo-02-serp-briefs/setup.mjs --dry-run            # (alias: --plan)
node .skills/seo-02-serp-briefs/setup.mjs --wave --dry-run     # first_wave only
# one target (build/QA mode):
node .skills/seo-02-serp-briefs/setup.mjs --only "how to make a wedding mood board"
# top-N of the content-map-ordered queue:
node .skills/seo-02-serp-briefs/setup.mjs --top 20
# the recommended initial batch (top clusters: hub + first ≥4 spokes):
node .skills/seo-02-serp-briefs/setup.mjs --wave
# force fresh SERP/crawl/research:
node .skills/seo-02-serp-briefs/setup.mjs --only "…" --no-cache

node .skills/seo-02-serp-briefs/verify.mjs
```

Flags: `--dry-run`/`--plan` (print plan, no spend), `--wave` (first_wave only),
`--top N` (first N of the ordered queue), `--only "<keyword>"` (exact-or-substring).

## Output

- `.supertools-state/seo-02-serp-briefs/briefs.json` — `page-briefs@1` artifact.
- `docs/seo/briefs/<slug>.md` — human-readable brief per page.
- `.supertools-state/seo-02-serp-briefs/serp|pages|research/` — raw evidence
  (full SERP, crawled bodies, Perplexity responses), all disk-cached.
- `.supertools-state/seo-02-serp-briefs.json` — receipt (records `consumes` hash
  of the upstream artifact for staleness).

## Config

Skill config: market, `topN`, `serpDepth`, `crawlTopK`, models, and
the product/brand block injected into the LLM prompts (CTA, brand constraints).

## Guardrails (playbook-mandated)

- **Format match wins over novelty** (§6.1/§7.4) — `recommended_format` tracks
  the SERP.
- **Unique angles are cited + confidence-scored + `needs_verification`** (§7.3) —
  factual claims never ship unverified; aesthetic/opinion angles need a source.
- **Novelty is measured against the crawled top-10**, not asserted.
- **Thin keyword-swap output is the anti-goal** (§15.2).

## Idempotency & cost

Every SERP / crawl / research call is disk-cached by input hash; re-runs reuse
and don't re-bill or re-crawl. A single-target run is a few cents (Perplexity
~$0.005/call + a little gpt-4o + 1 cheap SERP call; crawls are local/free).

## Common failure modes

| Symptom | Fix |
|---|---|
| `Crawl4AI not healthy` | Start the Crawl4AI service (`/health` at `CRAWL4AI_URL`). |
| `Upstream "seo-01-…" has not run` | Run `seo-01` first. |
| All crawls `blocked`/`timeout` | Brief still builds from titles + PAA; note coverage is thinner. Some publishers bot-block. |
| `Schema mismatch` | seo-01's artifact predates `keyword-targets@1`; re-run seo-01 (now stamps the version). |
