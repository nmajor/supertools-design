// The site-wide conversion target. `default_conversion` names the key in
// `conversion`; otherwise the first entry wins.
function defaultConversion(cfg) {
  const key = cfg.default_conversion;
  if (key && cfg.conversion?.[key]) return cfg.conversion[key];
  const first = Object.values(cfg.conversion || {})[0];
  if (!first) throw new Error('config has no "conversion" targets defined.');
  return first;
}

// Corpus-level content-map construction over seo-01's page targets.
// Pipeline: buildPages -> dedupe (cannibalization) -> clusterize (hub+anchor)
// -> linkGraph -> sequence -> validate. Pure functions; setup.mjs orchestrates.
// Grounded in the three research docs + docs/compact-keywords-guide.md §4-5,13.

import { slugify } from '../_shared/seo.mjs';
import {
  assignTopic, detectFormat, detectModifier, intentClass, classifyFunnel,
  templateFor, ctaStrength, differentiatorOf, primaryIntentKey, isBareHead, fitLevel, brandToken,
} from './classify.mjs';

const median = (xs) => {
  const a = xs.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  return a.length ? a[Math.floor((a.length - 1) / 2)] : null;
};

// 1) Decorate every target with topic / funnel / keys / template.
export function buildPages(targets, cfg) {
  return targets.map((t) => {
    const topic = assignTopic(t.keyword, cfg);
    const fmt = detectFormat(t.keyword, cfg);
    const diff = differentiatorOf(t.keyword, topic, cfg);
    const funnel = classifyFunnel(t, { isTool: fmt.formatWord || fmt.isTool }, cfg);
    // Intent-class override (cannibalization R3): a tool/generator/quiz page is a
    // DISTINCT intent from a browse page, regardless of DataForSEO's label — so it
    // never merges into the informational hub and instead becomes the BOFU anchor.
    const intent = fmt.isTool ? 'transactional' : intentClass(t.dfs_intent);
    const brand = brandToken(t.keyword, cfg);
    // Quarantine: off-topic (no subject) OR a rival's branded query. These are
    // emitted separately and NEVER enter pages/build_queue/funnel hubs/anchors.
    const quarantine_reason = brand ? `branded/competitor ("${brand}")` : topic === 'other' ? 'off-topic / off-product (no subject match)' : null;
    return {
      slug: slugify(t.keyword),
      keyword: t.keyword,
      topic,
      branded: !!brand,
      quarantined: !!quarantine_reason,
      quarantine_reason,
      differentiator: diff.value,
      diff_class: diff.modClass,
      is_tool: fmt.isTool,
      format_word: fmt.formatWord,
      funnel_stage: funnel.stage,
      funnel_confidence: funnel.confidence,
      funnel_reason: funnel.reason,
      intent_class: intent,
      pillar: t.pillar,
      product_fit: t.product_fit,
      fit_level: fitLevel(t.product_fit),
      template: templateFor(funnel.stage, fmt.isTool, t.pillar),
      cta_strength: ctaStrength(funnel.stage),
      primary_intent_key: primaryIntentKey(intent, topic, diff.value),
      bare_head: isBareHead(t.keyword, topic, cfg),
      // carried straight from seo-01
      cluster_volume: t.cluster_volume,
      primary_volume: t.primary_volume,
      keyword_difficulty: t.keyword_difficulty,
      priority: t.priority,
      dfs_intent: t.dfs_intent,
      variants: t.variants || [],
      variant_count: t.variant_count || 0,
    };
  });
}

// 2) Cannibalization dedupe: pages sharing a primary_intent_key target the same
//    intent -> MERGE (keep highest priority; fold the rest in as variants).
//    intent_class is in the key, so tool vs browse for one subject never merge;
//    subject modifiers (color/season/style) keep spokes distinct (the moat).
export function dedupe(pages) {
  const byKey = new Map();
  for (const p of pages) {
    if (!byKey.has(p.primary_intent_key)) byKey.set(p.primary_intent_key, []);
    byKey.get(p.primary_intent_key).push(p);
  }
  const kept = [];
  const merges = [];
  for (const group of byKey.values()) {
    if (group.length === 1) { kept.push(group[0]); continue; }
    group.sort((a, b) => b.priority - a.priority || b.cluster_volume - a.cluster_volume);
    const [head, ...rest] = group;
    head.merged_keywords = rest.map((r) => r.keyword);
    head.variants = [...new Set([...head.variants, ...rest.map((r) => r.keyword), ...rest.flatMap((r) => r.variants)])].slice(0, 24);
    head.cluster_volume += rest.reduce((s, r) => s + (r.cluster_volume || 0), 0);
    kept.push(head);
    merges.push({
      kept: head.slug, kept_keyword: head.keyword,
      merged: rest.map((r) => r.keyword), reason: `same primary_intent_key (${head.primary_intent_key}) — same intent, no distinct modifier`,
    });
  }
  return { pages: kept, merges };
}

// 3) Clusterize by topic; designate hub + funnel anchor; score; flag.
export function clusterize(pages, cfg) {
  const topicMeta = Object.fromEntries(cfg.topics.map((t) => [t.id, t]));
  const th = cfg.thresholds;
  const byTopic = new Map();
  for (const p of pages) {
    if (!byTopic.has(p.topic)) byTopic.set(p.topic, []);
    byTopic.get(p.topic).push(p);
  }

  const clusters = [];
  for (const [topicId, members] of byTopic.entries()) {
    const meta = topicMeta[topicId];
    const realTopic = topicId !== 'other';
    // A topic below the hub threshold is NOT a cluster — its members attach
    // laterally (no singleton hubs). setup.mjs lifts these out as lateral_pages.
    const belowThreshold = realTopic && members.length < th.min_spokes_for_hub;
    const buildableTopic = realTopic && !belowThreshold;
    members.sort((a, b) => b.priority - a.priority || b.cluster_volume - a.cluster_volume);

    // Hub = the bare-head, broadest, highest-volume informational page in the topic.
    // Only buildable topics get a hub; 'other' (noise) and below-threshold get none.
    const hubCandidates = buildableTopic
      ? members.filter((m) => m.bare_head && !m.is_tool && m.intent_class === 'informational')
      : [];
    let hub = hubCandidates.sort((a, b) => b.cluster_volume - a.cluster_volume)[0] || null;
    let interimHub = false;
    // No dedicated head-term page exists: the broadest spoke acts as INTERIM hub
    // so the cluster graph is connected (no orphans), and we flag "create a hub".
    if (!hub && buildableTopic && members.length) {
      hub = members.filter((m) => !m.is_tool).sort((a, b) => b.cluster_volume - a.cluster_volume)[0] || members[0];
      interimHub = true;
    }
    if (hub) hub.role = 'hub';
    const spokes = members.filter((m) => m !== hub);
    spokes.forEach((s) => (s.role = 'spoke'));

    // BOFU anchor = an OWNED in-cluster conversion page, else the topic's global
    // conversion page (the quiz, or the palette generator for colors). "Owned" =
    // BOFU + product_fit + not navigational + not branded — so we never anchor a
    // cluster to a competitor/branded or off-product page (codex review fix).
    const inClusterAnchor = realTopic
      ? members
          .filter((m) => m.funnel_stage === 'BOFU' && m.product_fit && m.intent_class !== 'navigational' && !m.branded)
          .sort((a, b) => b.priority - a.priority)[0] || null
      : null;
    if (inClusterAnchor) inClusterAnchor.cluster_anchor = true;
    const globalConv = meta ? cfg.conversion[meta.conversion] : defaultConversion(cfg);
    const anchor = inClusterAnchor
      ? { type: 'page', slug: inClusterAnchor.slug, keyword: inClusterAnchor.keyword }
      : { type: 'global', url: globalConv.url, label: globalConv.label };

    const kds = members.map((m) => m.keyword_difficulty).filter((n) => Number.isFinite(n));
    const clusterVolume = members.reduce((s, m) => s + (m.cluster_volume || 0), 0);
    const fitShare = members.filter((m) => m.product_fit).length / members.length;
    const medKd = median(kds);

    // Cluster priority score (architecture research §6): demand x beatable-KD x
    // product-fit x strategic-openness. Transparent, documented in the report.
    const kdFactor = medKd == null ? 0.6 : Math.max(0.1, (100 - medKd) / 100);
    const openness = Math.min(1, members.length / 12) + 0.3;
    const score = +(Math.log10(clusterVolume + 1) * kdFactor * (0.5 + fitShare / 2) * openness).toFixed(3);

    clusters.push({
      id: topicId,
      label: meta?.label || topicId,
      slug: meta?.slug || slugify(topicId),
      unmapped: !realTopic,
      below_threshold: belowThreshold,
      hub_type: meta?.hub_type || (anchor.type === 'page' ? 'commercial' : 'editorial'),
      hub_slug: hub?.slug || null,
      interim_hub: interimHub,
      // "needs a dedicated hub page" when none exists OR only an interim stands in.
      hub_needed: hub && !interimHub ? null : (meta?.head_term || `${topicId} hub`),
      anchor,
      members,
      spoke_count: spokes.length,
      cluster_volume: clusterVolume,
      median_kd: medKd,
      fit_share: +fitShare.toFixed(2),
      // 'other' is unmapped noise: score 0 so it sinks below real clusters.
      score: realTopic ? score : 0,
      low_fit: !!meta?.low_fit,
      singleton: realTopic && members.length < th.min_spokes_for_hub,
      geo_below_threshold: realTopic && spokes.length < th.geo_min_spokes,
      split_recommended: spokes.length > th.max_spokes_before_split,
    });
  }
  clusters.sort((a, b) => b.score - a.score);
  clusters.forEach((c, i) => (c.rank = i + 1));
  return clusters;
}

// 4) Internal-link plan per page (architecture research §3; playbook §5.3).
//    spoke -> up to hub + down to anchor + 1-3 siblings; hub -> down to spokes;
//    funnel flows toward conversion, never BOFU->TOFU upward within a cluster.
export function linkGraph(clusters, cfg) {
  const th = cfg.thresholds;
  const quizUrl = defaultConversion(cfg).url;
  for (const c of clusters) {
    // Unmapped noise bucket: no hub graph, just a soft link to the global quiz.
    if (c.unmapped) {
      for (const p of c.members) { p.links = { up: [], down: [], siblings: [], conversion: [{ url: quizUrl }] }; p.inbound = 0; }
      continue;
    }
    const hub = c.members.find((m) => m.role === 'hub');
    const spokes = c.members.filter((m) => m.role === 'spoke');
    for (const p of c.members) {
      const links = { up: [], down: [], siblings: [], conversion: [] };
      if (p.role === 'spoke') {
        if (hub) links.up.push(hub.slug);
        // siblings = nearest same-diff-class spokes (then any), capped
        const sib = spokes
          .filter((s) => s !== p && s.diff_class === p.diff_class)
          .concat(spokes.filter((s) => s !== p && s.diff_class !== p.diff_class))
          .slice(0, th.sibling_links)
          .map((s) => s.slug);
        links.siblings = sib;
        // conversion: link down to the cluster anchor unless this page IS it
        if (!p.cluster_anchor) {
          links.conversion.push(c.anchor.type === 'page' ? { slug: c.anchor.slug } : { url: c.anchor.url });
        }
      } else if (p.role === 'hub') {
        links.down = spokes.map((s) => s.slug); // hub links down to every spoke
        if (c.anchor.type === 'page' && c.anchor.slug !== p.slug) links.conversion.push({ slug: c.anchor.slug });
        else if (c.anchor.type === 'global') links.conversion.push({ url: c.anchor.url });
      }
      // cap total
      const total = links.up.length + links.siblings.length + links.conversion.length;
      if (links.down.length + total > th.max_internal_links && p.role === 'hub') {
        // hubs may exceed for down-links to all spokes (that's the pillar's job)
      }
      p.links = links;
      p.inbound = 0; // filled below
    }
  }
  // inbound counts for the orphan gate
  const bySlug = new Map();
  for (const c of clusters) for (const p of c.members) bySlug.set(p.slug, p);
  for (const c of clusters) for (const p of c.members) {
    for (const s of p.links.up) bySlug.get(s) && (bySlug.get(s).inbound++);
    for (const s of p.links.down) bySlug.get(s) && (bySlug.get(s).inbound++);
    for (const s of p.links.siblings) bySlug.get(s) && (bySlug.get(s).inbound++);
  }
  return clusters;
}

// 5) URL plan (architecture research §4): nest editorial hubs+spokes; keep
//    commercial/tool + transactional flat at root or under the BOFU /tools hub.
export function urlPlan(clusters, cfg) {
  for (const c of clusters) {
    const editorial = c.hub_type === 'editorial';
    for (const p of c.members) {
      if (p.is_tool || p.funnel_stage === 'BOFU') {
        p.url_path = `/${p.slug}/`; // flat root for converters (playbook §5.1)
      } else if (p.role === 'hub') {
        p.url_path = `/${c.slug}/`;
      } else if (editorial) {
        p.url_path = `/${c.slug}/${p.slug.replace(/^wedding-/, '')}/`; // nested spoke
      } else {
        p.url_path = `/${p.slug}/`;
      }
      // funnel-hub membership (the navigational index it appears under)
      p.funnel_hub = cfg.funnel_hubs[p.funnel_stage]?.path || null;
    }
  }
  return clusters;
}

// 6) Build sequencing (architecture §6 + funnel §4): BOFU-first, ship a thin hub
//    + its first >=N spokes as a unit, never a spoke before its hub.
export function sequence(clusters, cfg) {
  const th = cfg.thresholds;
  const stageRank = { BOFU: 0, MOFU: 1, TOFU: 2 };
  const queue = [];
  for (const c of clusters) {
    const ordered = [...c.members].sort(
      (a, b) => stageRank[a.funnel_stage] - stageRank[b.funnel_stage] || b.priority - a.priority
    );
    // hub first (so spokes have a link target), then BOFU, then by priority
    const hub = ordered.find((m) => m.role === 'hub');
    const rest = ordered.filter((m) => m !== hub);
    const seq = [hub, ...rest].filter(Boolean);
    seq.forEach((p, i) => queue.push({
      slug: p.slug, keyword: p.keyword, cluster: c.id, cluster_rank: c.rank,
      role: p.role, funnel_stage: p.funnel_stage, within_cluster_order: i + 1,
      gated_on: p.role === 'spoke' && hub ? hub.slug : null,
    }));
  }
  // global order: cluster rank, then within-cluster order
  queue.sort((a, b) => a.cluster_rank - b.cluster_rank || a.within_cluster_order - b.within_cluster_order);
  queue.forEach((q, i) => (q.build_order = i + 1));
  // first wave = top-N REAL clusters shipped cluster-complete (hub + first >=4 spokes)
  const firstWaveClusters = clusters.filter((c) => !c.unmapped).slice(0, th.first_wave_clusters);
  const firstWave = firstWaveClusters.flatMap((c) => {
    const hub = c.members.find((m) => m.role === 'hub');
    // Always include the owned conversion anchor so the first wave is genuinely
    // "anchored on conversion" (the subset seo-02 briefs first).
    const anchorPage = c.anchor.type === 'page' ? c.members.find((m) => m.slug === c.anchor.slug) : null;
    const spokes = c.members.filter((m) => m.role === 'spoke' && m !== anchorPage)
      .sort((a, b) => b.priority - a.priority).slice(0, Math.max(th.min_spokes_for_hub, 4));
    return [hub, anchorPage, ...spokes].filter(Boolean).map((p) => p.slug);
  });
  return { build_queue: queue, first_wave: firstWave, first_wave_clusters: firstWaveClusters.map((c) => c.id) };
}

// 7) Validators (the hard gates the map must surface).
export function validate(clusters, pages, cfg) {
  const th = cfg.thresholds;
  const orphans = [];
  const mixed_intent = [];
  for (const c of clusters) {
    if (c.unmapped) continue; // noise bucket, not part of the architecture
    for (const p of c.members) {
      if ((p.inbound || 0) === 0 && p.role !== 'hub') orphans.push(p.slug);
      // a TOFU/MOFU spoke with no downward path to a conversion page is a bug
      if (p.role === 'spoke' && p.funnel_stage !== 'BOFU' && p.links.conversion.length === 0) mixed_intent.push(p.slug);
    }
  }
  const no_hub_clusters = clusters.filter((c) => c.hub_needed && !c.unmapped && !c.singleton).map((c) => c.id);
  const singleton_hubs = clusters.filter((c) => c.singleton).map((c) => c.id);
  const split_recommended = clusters.filter((c) => c.split_recommended && !c.unmapped).map((c) => ({ id: c.id, spokes: c.spoke_count }));
  const geo_below = clusters.filter((c) => c.geo_below_threshold && c.id !== 'other').map((c) => c.id);
  const needs_review = pages.filter((p) => p.funnel_confidence === 'low').map((p) => ({ slug: p.slug, stage: p.funnel_stage, reason: p.funnel_reason }));
  return { orphans, mixed_intent, no_hub_clusters, singleton_hubs, split_recommended, geo_below, needs_review };
}

export { median };
