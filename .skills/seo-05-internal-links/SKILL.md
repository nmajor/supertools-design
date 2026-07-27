---
name: seo-05-internal-links
description: Inject the content-map's internal-link graph into the built guide pages — hub↔spoke, sibling, and conversion links rendered as an in-content "Keep planning" section — so each cluster is interlinked in-content, not just via the footer/index pages. Deterministic, offline, idempotent.
---

# seo-05 — Internal Links (in-content link graph)

The last linking stage. The footer + funnel-index pages (`docs/seo/homepage-hub-linking.md`)
de-orphan the SEO pages *navigationally*; this skill adds the *contextual*
hub↔spoke link graph **inside** each page body, which is where most topical
equity flows (playbook §5.2–5.3, architecture-clusters §3).

seo-04's page template has no related-links slot, so this is a **post-processor**:
it reads the content-map graph + the built-page registry and injects a
marker-delimited `RELATED` const + a "Keep planning" `<section>` into each
already-built route file. No re-draft, no LLM, no network.

## What it does

For every built guide page it composes, from the content-map link graph:
- **spoke → hub** (the cluster pillar), **hub → spokes** (down to each built spoke),
- **1–3 sibling** spokes (same cluster), and
- **a conversion link** to the cluster's real tool — the colors cluster anchors to
  the existing `/tools/wedding-color-palette-generator`, every other cluster to the
  the site-wide conversion target (skill config).

Then it injects them as plain, crawlable `<a href>` links (descriptive keyword
anchors), capped at `max_links` (playbook §5.3). **Links only ever point at pages
that are actually built** (filtered against the seo-04 registry) so nothing 404s;
unbuilt siblings simply fill in as more pages ship. Never self-links; never links
a competitor (`_shared/competitors.mjs`).

## Invariants (verify.mjs, hard gate)

- Upstreams `content-map@1` + `compact-pages@1` readable and not stale.
- Every built page carries a `RELATED` const + the `{/* seo-05:related */}` section
  with ≥1 link.
- Every injected href resolves to a built route or a configured conversion URL —
  no dangling links, no self-links, no competitor links.
- Idempotent: the block is marker-delimited, so a re-run **replaces** it (a re-run
  leaves exactly one block; the TS build would fail on a duplicated const otherwise).

## Run

```
node .skills/seo-05-internal-links/setup.mjs    # after seo-04 has built pages
node .skills/seo-05-internal-links/verify.mjs
npm run build                                    # the injected JSX must compile
```

Run **after** seo-04. If seo-04 later rebuilds a page (which drops the injected
block), re-run this. Output: `internal-links@1`
(`.supertools-state/seo-05-internal-links/internal-links.json`) + the patched
route files. Deterministic and offline; the only per-run variation is
`generated_at`. Tune conversion targets + caps in the skill config.
