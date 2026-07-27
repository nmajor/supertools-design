#!/usr/bin/env node
// seo-03-page-images — generate photorealistic, on-brand images for a guide page.
//
// Own pipeline step (per docs/research/image-seo-and-policy.md): seeded from the
// seo-02 brief, separate from text gen so images can be regenerated/cached on
// their own. Uses FLUX.2 [pro] via fal.ai (the app's production image model):
// a hero (text-to-image) + supporting images conditioned on the hero (one-shoot
// consistency). Positive-only prompts (FLUX ignores negatives); no people, no
// text — enforced by flat-lay/objects-only composition. Optimized to WebP.
//
// Consumes:  page-briefs@1  (seo-02-serp-briefs/briefs.json)
// Provides:  page-images@1  (.supertools-state/seo-03-page-images/images.json)
//            + WebP assets in public/img/guides/<slug>/
//
// Usage: node .skills/seo-03-page-images/setup.mjs --only "how to make a wedding mood board"

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PROJECT_ROOT, loadEnv } from '../_shared/env.mjs';
import { resolveProjectConfig } from '../_shared/project.mjs';
import { STATE_DIR, writeState } from '../_shared/state.mjs';
import { readUpstream, assertSchema, slugify, recordConsumes } from '../_shared/seo.mjs';
import { chatJSON } from '../_shared/openai.mjs';
import { cleanCopy } from '../_shared/copy.mjs';
import { falImage, falConfigured } from '../_shared/fal.mjs';

const SKILL_ID = 'seo-03-page-images';
const UPSTREAM = 'seo-02-serp-briefs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnv();
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set (image art-direction).');
if (!falConfigured()) throw new Error('FAL_API_KEY not set (image generation).');

const cfg = JSON.parse(fs.readFileSync(resolveProjectConfig(HERE, 'config'), 'utf-8'));
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const slugArg = argv.includes('--slug') ? argv[argv.indexOf('--slug') + 1] : null;

// ---------- upstream ----------
const { data: pb, hash: pbHash } = await readUpstream(UPSTREAM, 'briefs.json');
assertSchema(pb, 'page-briefs@1');
let brief;
if (slugArg) brief = pb.briefs.find((b) => b.slug === slugArg);
else if (only) { const q = only.toLowerCase().trim(); brief = pb.briefs.find((b) => b.primary_keyword.toLowerCase().includes(q)); }
else brief = pb.briefs[0];
if (!brief) throw new Error(`No brief matched. Available: ${pb.briefs.map((b) => b.slug).join(', ')}`);
const slug = brief.slug || slugify(brief.primary_keyword);
console.log(`[img] generating images for "${brief.primary_keyword}"`);

// deterministic master seed from slug (reproducible; no Math.random)
const masterSeed = parseInt(crypto.createHash('sha1').update(slug).digest('hex').slice(0, 7), 16) % 2_000_000;

// ---------- 1. art direction (gpt-4o picks a cohesive, on-brand aesthetic) ----------
const V = cfg.style_vocab;
const plan = await chatJSON(
  `You are ${cfg.org?.name || cfg.product?.name || 'the brand'}'s photo art director. Plan ${cfg.images_per_page} photorealistic editorial images for a guide page titled "${brief.primary_keyword}".
The images must be GENUINELY USEFUL to the reader (demonstrative, not decoration) and on-brand for a wedding-aesthetic tool.

Pick ONE cohesive aesthetic, then plan the images as overhead flat-lays / styling details — OBJECTS AND SURFACES ONLY. Absolutely no people, no faces, no hands, and no printed text/words in the image (cards are blank).

Image 1 MUST be a believable overhead WEDDING MOOD BOARD flat-lay (the page's hero): an arranged board of fabric swatches, a few fresh stems, paint/color chips, a ribbon, a blank card, textured paper — a real stylist's board, not a digital collage. The other ${cfg.images_per_page - 1} images are supporting styling details in the SAME aesthetic (e.g. a floral detail, a palette/materials detail).

Return JSON:
{
  "aesthetic_name": "2-4 word evocative name (not 'Romantic Elegance')",
  "descriptors": ["three","lowercase","feeling words"],
  "palette": [ {"name":"real designer color name","hex":"#RRGGBB"} ],  // 5 swatches
  "medium": "one of: ${V.media.join(' | ')}",
  "lighting": "one of: ${V.lighting.join(' | ')}",
  "refs": ["1-2 of: ${V.refs.join(', ')}"],
  "images": [
    { "role": "hero|floral|materials|decor|stationery",
      "subject": "12-25 words, overhead flat-lay of named objects/species/materials, NO people, NO text",
      "camera": "lens + angle, e.g. 'medium-format Hasselblad, top-down flat-lay'",
      "aspect": "3:2",
      "alt": "descriptive alt text 80-140 chars: what the image shows, in plain language, no keyword stuffing",
      "caption": "short evocative visible caption, 4-10 words, in voice — name what's in frame (e.g. 'Sage linen, eucalyptus, and a blush silk ribbon')" }
  ]
}
Make subjects specific (name flowers, fabrics, the hex colors). Keep all ${cfg.images_per_page} images in one coherent aesthetic.`,
  { system: 'You return only valid JSON.', temperature: 0.6 }
);
const paletteStr = (plan.palette || []).map((s) => `${s.name.toLowerCase()} (${s.hex})`).join(', ');
console.log(`[img]   aesthetic: ${plan.aesthetic_name} — ${(plan.images || []).length} images`);

function buildPrompt(img) {
  // Positive-only (no avoid block). No-people/no-text enforced by composition.
  return (
    `${plan.aesthetic_name}, ${(plan.descriptors || []).join(', ')}. ` +
    `Editorial wedding photography, shot on ${plan.medium}, ${plan.lighting}, ` +
    `color palette of ${paletteStr}. Aesthetic references: ${(plan.refs || []).join(', ')}. ` +
    `${V.anti_slop}. Overhead flat-lay, natural composition, objects and surfaces only — ` +
    `an empty styled scene with no people anywhere and no printed words or letters. ` +
    `Subject: ${img.subject}. Camera: ${img.camera}.`
  );
}

// ---------- 2. generate (hero, then supporting conditioned on hero) ----------
const outDir = path.join(PROJECT_ROOT, cfg.out_dir, slug);
await fsp.mkdir(outDir, { recursive: true });
const images = [];
let heroUrl = null;
for (let i = 0; i < (plan.images || []).length; i++) {
  const img = plan.images[i];
  const role = img.role || (i === 0 ? 'hero' : `detail-${i}`);
  const isHero = i === 0;
  const prompt = buildPrompt(img);
  console.log(`[img]   ${isHero ? 'hero' : role} → fal flux-2-pro${isHero ? '' : '/edit (ref=hero)'} …`);
  const gen = await falImage({
    prompt,
    aspect: img.aspect || '4:3',
    seed: masterSeed + i,
    referenceUrl: isHero ? null : heroUrl,
  });
  if (isHero) heroUrl = gen.url;
  // download + optimize -> webp
  const resp = await fetch(gen.url);
  if (!resp.ok) throw new Error(`download failed ${resp.status} for ${role}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const file = `${role}.webp`;
  const meta = await sharp(buf)
    .resize({ width: cfg.max_width, withoutEnlargement: true })
    .webp({ quality: cfg.webp_quality })
    .toFile(path.join(outDir, file));
  images.push({
    role,
    src: `${cfg.public_base}/${slug}/${file}`,
    alt: cleanCopy((img.alt || `${plan.aesthetic_name} wedding ${role} flat-lay`).slice(0, 160)),
    caption: cleanCopy((img.caption || '').slice(0, 120)),
    width: meta.width,
    height: meta.height,
    bytes: meta.size,
    seed: gen.seed,
    model: gen.model,
    prompt,
  });
  console.log(`[img]     wrote ${file} ${meta.width}x${meta.height} ${(meta.size / 1024).toFixed(0)}KB`);
}

// ---------- 3. artifact + receipt ----------
const WORK = path.join(STATE_DIR, SKILL_ID);
await fsp.mkdir(WORK, { recursive: true });
const imagesPath = path.join(WORK, 'images.json');
let existing = { items: [] };
try { existing = JSON.parse(await fsp.readFile(imagesPath, 'utf-8')); } catch {}
const items = (existing.items || []).filter((it) => it.slug !== slug);
items.push({ slug, aesthetic: plan.aesthetic_name, palette: plan.palette, master_seed: masterSeed, images });
const artifact = {
  schema_version: 'page-images@1',
  generated_at: new Date().toISOString(),
  source: { skill: UPSTREAM, artifact_hash: pbHash },
  provenance: { generator: 'fal-ai/flux-2-pro', ai_generated: true, iptc_digital_source_type: 'trainedAlgorithmicMedia' },
  org: cfg.org,
  license_url: cfg.license_url,
  items,
};
await fsp.writeFile(imagesPath, JSON.stringify(artifact, null, 2));

await writeState(SKILL_ID, {
  status: 'ok',
  version: '0.1',
  timestamp: new Date().toISOString(),
  summary: `Generated ${images.length} images for "${slug}" (${plan.aesthetic_name}).`,
  provides: ['page-images'],
  consumes: recordConsumes([{ producerId: UPSTREAM, artifact: 'page-briefs', hash: pbHash }]),
  imageCount: images.length,
  data: path.relative(PROJECT_ROOT, imagesPath),
});

console.log('\n---SETUP_DONE---');
console.log(JSON.stringify({
  status: 'ok',
  slug,
  aesthetic: plan.aesthetic_name,
  images: images.map((i) => `${i.role} ${i.width}x${i.height} ${(i.bytes / 1024).toFixed(0)}KB ${i.src}`),
}, null, 2));
