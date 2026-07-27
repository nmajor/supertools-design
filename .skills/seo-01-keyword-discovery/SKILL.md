---
name: seo-01-keyword-discovery
description: Discover bottom-of-funnel keyword targets for a niche, enriched with search volume + search intent + keyword difficulty, using DataForSEO. Implements the Compact Keywords playbook discovery process and ranks candidates into Category / Comparison / JTBD pillars.
---

# seo-01 — Keyword Discovery

First skill in the **SEO / growth** series (separate from the `00`–`17` build
pipeline). It turns a niche profile into a **ranked, deduplicated keyword
target list** with search volume, search intent, and keyword difficulty (KD) —
the input every later compact-keyword page is built from.

It is a faithful, automated implementation of **`docs/compact-keywords-guide.md`
§3 (Keyword Discovery)** and §2 (the three pillars). It does not write app
pages — it produces the research artifact that drives them.

## What it does

The discovery pipeline (each stage maps to the playbook):

1. **Brainstorm** (§3.1 step 1) — seeds, competitors, and JTBD queries from the
   niche profile.
2. **Modifier stacking** (§3.3, Appendix A) — synthesizes candidates by filling
   pattern templates (`{m} wedding mood board`) from modifier sets
   (styles / colors / seasons / venues). Real demand is confirmed in stage 5,
   so speculative combos that nobody searches are filtered out.
3. **SERP harvest** (§3.1 step 2) — pulls **People Also Ask** + **Related
   Searches** for a few seed queries via `serp_organic_live_advanced`.
4. **Tool augmentation** (§3.1 step 3) — expands seeds with
   `keyword_suggestions` (long-tail containing the seed) and `keyword_ideas`
   (broader same-category ideas).
5. **Enrich** — every deduped candidate goes through
   `keyword_overview` (batched ≤700) for **search volume + KD + search intent**
   in one pass.
6. **Classify** (§2) — each keyword is bucketed into a pillar
   (**Category / Comparison / JTBD**) and flagged for direct **product fit**.
7. **Score & rank** (§4.1) — a 0–100 composite that weights rankability (KD) ×
   intent × product-fit above raw volume (the BOFU thesis: a 50-vol query at
   15% beats a 5,000-vol query at 0.5%). CPC is folded in as a small value input.
8. **Cluster → page targets** (§3.8) — collapses near-duplicate keywords (word-
   order variants etc.) into **page targets** using DataForSEO's `core_keyword`
   signal, since the real deliverable is a page count, not a flat keyword list.
   The highest-priority keyword in each cluster is the primary; the rest are
   on-page variants, and `cluster_volume` sums the cluster's demand.

## DataForSEO transport

Auto-selected by `_shared/dataforseo.mjs`:

- **MCP (preferred)** — a local DataForSEO MCP server at `DATAFORSEO_MCP_URL`.
  In this project the raw REST account lacks Labs access, but the MCP server is
  provisioned, so MCP is the working path.
- **REST fallback** — `DATAFORSEO_USERNAME` + `DATAFORSEO_PASSWORD` basic-auth,
  for a checkout where the MCP server isn't running.

Both come from `process.env` (general env vars or `.env`).

## Niche profile

The unit of input is a JSON profile (default
`niche.<projectName>.json`, falling back to `niche.example.json`). Copy
`niche.example.json` to `niche.<projectName>.json` to target your niche.
Key fields: `seeds`, `expandSeeds` (cost-control subset), `patterns` +
`modifierSets` (modifier stacking), `jtbd`, `competitors`, `serpSeeds`,
`location_name`, `language_code`, `limits`.

The example profile's modifier sets are drawn from
`docs/content-engine/style-taxonomy.md`, so discovered keywords map onto
aesthetics the product can actually generate.

## Steps

1. Run discovery (uses your niche profile):
   ```sh
   node .skills/seo-01-keyword-discovery/setup.mjs
   # or a different niche:  node .skills/seo-01-keyword-discovery/setup.mjs path/to/niche.json
   # force-refresh cache:    node .skills/seo-01-keyword-discovery/setup.mjs --no-cache
   ```
2. Verify:
   ```sh
   node .skills/seo-01-keyword-discovery/verify.mjs
   ```
   Round-trips a live `keyword_overview` call and asserts the run produced a
   non-trivial, fully-enriched, priority-sorted keyword set with agreeing
   csv / markdown / receipt.

## Output

- **`docs/seo/keyword-discovery-<niche>.md`** — human report: top-30 **page
  targets (clustered)**, top-30 keywords, top targets per pillar, with read-me
  guidance.
- `.supertools-state/seo-01-keyword-discovery/keywords.json` — full structured data.
- `.supertools-state/seo-01-keyword-discovery/report.csv` — spreadsheet-ready.
- `.supertools-state/seo-01-keyword-discovery/cache/` — per-call response cache.
- `.supertools-state/seo-01-keyword-discovery.json` — receipt.

## Idempotency & cost

Every DataForSEO call is cached on disk by `(tool, args)` hash. Re-runs reuse
cached responses and **do not re-bill**. `--no-cache` forces fresh calls. Cost
is bounded by `limits` in the niche profile (`suggestionLimit`, `ideaLimit`,
`maxCandidates`, `overviewBatch`) — a default run is well under $1 on
a ~$9 balance.

## Common failure modes

| Symptom | Fix |
|---|---|
| `No DataForSEO transport available` | Start the MCP server (`DATAFORSEO_MCP_URL`) or set `DATAFORSEO_USERNAME`/`PASSWORD`. |
| `You are not authorized to access this resource` (REST) | The raw account lacks Labs access. Use the MCP transport — it holds a provisioned account. |
| Many rows with null KD | KD is only computed for keywords with enough ranking data; null is common on thin long-tail. Treated as neutral-good (rankable). Trust `priority`. |
| Most rows tagged `informational` | Expected for a consumer generator niche. `product_fit=yes` marks queries the quiz/pack answers directly — those are the real BOFU regardless of label. |
| Synthetic combos with 0 volume | By design — modifier stacking over-generates, then enrichment filters to measurable demand. |
