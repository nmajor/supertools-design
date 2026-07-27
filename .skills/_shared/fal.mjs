// fal.ai client for the seo image step — FLUX.2 [pro] text-to-image + the
// reference-conditioned /edit endpoint (hero as reference → "one shoot"
// consistency across a page's image set). Mirrors src/generation/tiles.ts.
// Credentials from FAL_API_KEY (or FAL_KEY).

import { createFalClient } from '@fal-ai/client';

export const FLUX_MODEL = 'fal-ai/flux-2-pro';
export const FLUX_EDIT_MODEL = 'fal-ai/flux-2-pro/edit';

export function falConfigured() {
  return !!(process.env.FAL_API_KEY || process.env.FAL_KEY);
}

let _client;
function client() {
  if (!falConfigured()) throw new Error('FAL_API_KEY not set');
  if (!_client) _client = createFalClient({ credentials: () => process.env.FAL_API_KEY || process.env.FAL_KEY });
  return _client;
}

// Map our aspect tokens to fal's named sizes (1024-class) — same as tiles.ts.
export function falImageSize(aspect) {
  return (
    {
      '1:1': 'square_hd',
      '4:3': 'landscape_4_3',
      '3:4': 'portrait_4_3',
      '3:2': 'landscape_16_9',
      '2:3': 'portrait_16_9',
    }[aspect] ?? 'landscape_4_3'
  );
}

/**
 * Generate one image. If `referenceUrl` is given, uses the reference-conditioned
 * /edit endpoint for cohesion with the hero. Returns { url, width, height, seed }.
 */
export async function falImage({ prompt, aspect = '4:3', seed, referenceUrl, timeoutMs = 180000 }) {
  const model = referenceUrl ? FLUX_EDIT_MODEL : FLUX_MODEL;
  const input = {
    prompt,
    image_size: falImageSize(aspect),
    num_images: 1,
    output_format: 'png',
    ...(seed != null ? { seed } : {}),
    ...(referenceUrl ? { image_urls: [referenceUrl] } : {}),
  };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await client().subscribe(model, { input, abortSignal: ac.signal });
    const data = res?.data ?? res;
    const img = data?.images?.[0];
    if (!img?.url) throw new Error(`fal ${model} returned no image: ${JSON.stringify(data).slice(0, 200)}`);
    return { url: img.url, width: img.width ?? null, height: img.height ?? null, seed: data.seed ?? seed ?? null, model };
  } finally {
    clearTimeout(t);
  }
}
