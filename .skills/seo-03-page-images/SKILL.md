---
name: seo-03-page-images
description: Generate photorealistic, on-brand images for a guide page using FLUX.2 [pro] via fal.ai — a hero wedding mood-board flat-lay plus reference-conditioned supporting details, optimized to WebP. Its own pipeline step, seeded from the seo-02 brief; provides page-images for seo-04-page-build to embed.
---

# seo-03 — Page Images

Own step in the `seo-*` series (the research said image gen should be separate
from text: independent retries, caching, regeneration, a no-faces quality gate).
Consumes `page-briefs@1`; provides `page-images@1`.

Grounded in `docs/research/image-gen-photoreal.md` + `image-seo-and-policy.md`
and the project's in-house prompt engine (`src/generation/prompts.ts`), if it has one.

## How it works

1. **Art direction** (gpt-4o) — picks one cohesive aesthetic + plans
   `images_per_page` flat-lays/details. Image 1 is always a believable **wedding
   mood-board flat-lay** (the demonstrative hero); the rest are supporting
   details in the same aesthetic.
2. **Generate** — FLUX.2 [pro] (`fal-ai/flux-2-pro`) for the hero; the
   reference-conditioned `/edit` endpoint (hero in `image_urls`) for the others
   → "one shoot" consistency. Deterministic seeds from the slug.
3. **Optimize** — `sharp` → WebP (`max_width` / `webp_quality`), written to
   `public/img/guides/<slug>/`.

## Prompt rules (from the research)

- **Positive-only prompts — no avoid/negative block.** FLUX.2 ignores negatives
  (CFG=1) and can inject avoided concepts as positives. No-people / no-text is
  enforced by **composition** ("overhead flat-lay, objects and surfaces only, no
  people anywhere, no printed words").
- **Anti-slop** photographic detail (film grain, halation, shallow DoF,
  paper-fiber/fabric-weave, natural wilt) instead of "8k/masterpiece/flawless",
  which cause the waxy AI look.
- In-house vocabulary: film stock (Portra/Hasselblad), lighting, palette hexes,
  photographer refs (composition cues).
- Brand hard rules: **no people ever, no text in images, specific species/materials.**

## Steps

```sh
node .skills/seo-03-page-images/setup.mjs --only "how to make a wedding mood board"
node .skills/seo-03-page-images/verify.mjs
```

## Output

- `public/img/guides/<slug>/*.webp` — the optimized images (served as static assets).
- `.supertools-state/seo-03-page-images/images.json` — `page-images@1` (per image:
  `src`, `alt`, `width`, `height`, `seed`, `prompt`, model) + provenance
  (`iptc_digital_source_type: trainedAlgorithmicMedia`, `ai_generated: true`).
- `.supertools-state/seo-03-page-images.json` — receipt.

## Notes / follow-ups

- Storage: v1 commits WebP to `public/`. At scale, move to R2 (`ARTIFACTS`
  binding) + Cloudflare Images transforms (AVIF/WebP negotiation) per the research.
- Provenance: the `trainedAlgorithmicMedia` tag is recorded in the artifact +
  surfaced in ImageObject schema by page-build; embedding it as IPTC/XMP in the
  file (C2PA) is a follow-up.
- FAL cost: ~$0.03–0.06/image (FLUX.2 [pro]). Re-runs regenerate (no cache yet).

## Common failure modes

| Symptom | Fix |
|---|---|
| `FAL_API_KEY not set` | Add it to `.env` / env. |
| A face or text appears | Re-run (new seed) or tighten the subject to objects-only; never add a negative block. |
| Image too large | Lower `max_width` / `webp_quality` in config. |
