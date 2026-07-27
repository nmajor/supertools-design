// seo-04 structured data — HowTo/Article + FAQPage + ImageObject JSON-LD, built
// deterministically from the already-cleaned content fields. (Schema choices per
// docs/research/content-seo-intent-linking.md §6 GEO.)

export function buildJsonLd({ brief, content, canonical, org, images = [], siteOrigin }) {
  const ld = [];
  const orgNode = { '@type': 'Organization', name: org?.name, url: org?.url || siteOrigin };

  if (brief.brief.schema_type === 'HowTo' && (content.how_to_steps || []).length) {
    ld.push({
      '@context': 'https://schema.org',
      '@type': 'HowTo',
      name: content.h1,
      description: content.meta_description,
      step: content.how_to_steps.map((s, i) => ({
        '@type': 'HowToStep',
        position: i + 1,
        name: s.name,
        text: s.text,
      })),
    });
  } else {
    ld.push({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: content.h1,
      description: content.meta_description,
      publisher: orgNode,
      mainEntityOfPage: canonical,
    });
  }

  if ((content.faq || []).length) {
    ld.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: content.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }

  // ImageObject per generated image — image rich results + E-E-A-T provenance.
  for (const [i, im] of images.entries()) {
    ld.push({
      '@context': 'https://schema.org',
      '@type': 'ImageObject',
      contentUrl: `${siteOrigin}${im.src}`,
      creditText: org?.name,
      creator: orgNode,
      ...(i === 0 ? { representativeOfPage: true } : {}),
    });
  }

  return ld;
}
