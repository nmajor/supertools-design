---
name: seo-01b-content-map
description: Turn seo-01's flat keyword targets into a deliberate hub-and-spoke + funnel content architecture before any page is built — clusters, funnel-stage tags, an internal-link graph, cannibalization guards, and a prioritized build queue. Prevents 660 orphaned pages and pages that compete with each other.
---

# seo-01b — Content Map (architecture & sequencing)

The planning layer between **seo-01** (keyword discovery) and **seo-02** (SERP
briefs). seo-01 answers *"which keywords?"*; this skill answers *"how do they fit
together, which order do we build them, and how do we keep them from cannibalizing
each other?"* — **before** we spend a page-build on anything.

It is a faithful, deterministic implementation of three research syntheses:
`docs/research/content-architecture-clusters.md` (hub-and-spoke),
`content-funnel-mapping.md` (TOFU/MOFU/BOFU), and `content-cannibalization.md`
(one page per intent), all reconciled against `docs/compact-keywords-guide.md`
§4–5 and §13.6.

## The philosophy — "dual-indexed graph, anchored on conversion"

1. **Clusters are the architecture.** Targets group by *subject* (colors, mood
   boards, aesthetics, decor, flowers, invitations) into hub-and-spoke clusters.
   A target is a **hub** only when a bare head term exists and ≥4 targets are
   modifier-extensions of it; **no singleton hubs** (a <4-spoke topic attaches
   laterally / flat). Where the head term isn't its own search, the broadest
   spoke stands in as an **interim hub** and the map flags "create a hub page".
2. **Funnel stage is a tag overlay,** derived per page by an ordered cascade over
   `(intent, format/subject modifiers, pillar, product_fit)`. **Format words**
   (`generator`/`quiz`/`maker`) drive funnel + template, *not* topic — so
   "wedding color palette generator" is the **BOFU anchor** of the colors
   cluster while "wedding color palette" is its editorial hub. Each cluster
   anchors *down* onto a conversion page (its own tool, else the global quiz /
   palette tool). The **TOFU/MOFU/BOFU hubs** (`/inspiration`, `/guides`,
   `/tools`) are navigational index views over the one corpus.
3. **Quarantine, for real.** Off-topic / off-product targets (no subject match)
   and **competitor/branded** queries (a rival's brand token, per the project's
   hard no-competitor rule) are held OUT of the buildable corpus entirely —
   emitted as `quarantined_targets`, never in `pages`, `build_queue`, the funnel
   hubs, or as a cluster anchor. A cluster's BOFU anchor must be an **owned**
   conversion page (`product_fit`, non-navigational, non-branded) or the global
   quiz / palette tool — never a competitor or off-product page.
4. **No cannibalization.** Every page gets a unique
   `primary_intent_key = (intent_class, topic, differentiator)`. Same key → merge
   (this catches distinct-`core_keyword`, same-intent collisions seo-01 can't see,
   e.g. *palette* vs *scheme*). `intent_class` is in the key, so a tool page and a
   browse page for one subject never wrongly merge; subject modifiers
   (color/season/style) are **protected** from over-merge — the compact-page moat. The
   SERP-overlap adjudicator (≥60% shared top-10) is deferred to seo-02, which
   captures live SERPs; this stage does the deterministic lexical+intent+modifier
   pass.

## What it does (each step maps to the research)

1. **Decorate** every target with topic, format/modifier, funnel stage + reason,
   intent class, template, CTA strength, and the cannibalization key.
2. **Cannibalization merge** — fold same-`primary_intent_key` targets into one
   page (the rest become on-page variants), recording every merge.
3. **Clusterize** — group by topic; designate hub + BOFU anchor; score each
   cluster `log10(volume) × beatable-KD × product-fit × openness`; flag
   singletons, <5-spoke (below AI-citation threshold), and oversize (split) ones.
4. **Link graph** — emit a per-page plan: spoke→hub (up), hub→spokes (down),
   1–3 siblings, 1–2 down to the conversion anchor. Hard **orphan gate**.
5. **URL plan** — nest editorial hubs/spokes (`/wedding-colors/dusty-blue/`),
   keep commercial/tool + BOFU flat at root (playbook §5.1).
6. **Sequence** — a BOFU-first build queue, hub-before-spoke, plus a **first
   wave** of the top clusters shipped cluster-complete (hub + first ≥4 spokes).
7. **Validate + report** — surface orphans, clusters needing a hub, splits, and
   the unmapped/off-product bucket (a large bucket means seo-01 needs tighter
   disqualification).

## Output

- **Artifact:** `.supertools-state/seo-01b-content-map/content-map.json`
  (`content-map@1`) — clusters, pages (dual-indexed by cluster + funnel hub),
  link graph, build queue + first wave, cannibalization merges, validators.
- **Human report:** `docs/seo/content-map-<projectName>.md`.
- **Receipt:** `provides: ["content-map"]`, records the upstream hash for staleness.

## Downstream

- **seo-02-serp-briefs** should consume `build_queue` / `first_wave` to decide
  *which* targets to brief and in what order (instead of walking the flat list).
- **seo-04-page-build** consumes each page's `template`, `cta_strength`,
  `url_path`, and `funnel_stage`.
- **seo-05-internal-links** consumes the `links` graph + `funnel_hubs` directly.

## Run

```
node .skills/seo-01b-content-map/setup.mjs           # uses config.<projectName>.json
node .skills/seo-01b-content-map/verify.mjs          # invariants: unique keys, no orphans, hub-before-spoke
```

Deterministic + offline: no network, no API keys. The content is a pure function
of seo-01's artifact + the skill config (the topic taxonomy, modifier
sets, funnel words, thresholds) — the only per-run variation is the
`generated_at` timestamp. Both the upstream hash and the config hash are recorded
in the receipt; `verify.mjs` is a hard gate that fails on a stale chain (changed
upstream OR config), a missing artifact/report, or any broken invariant. Tune the
taxonomy in the skill config, not in code.
