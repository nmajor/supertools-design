// Canonical accessor for per-project identity.
//
// Every skill that needs the project's name, brand name, or domain reads it
// from here — never from a hardcoded literal. `01-project-init` writes
// `.supertools-state/project.json`; `00-prereqs` validates the domain.
//
// This is the seam that makes the pipeline reusable: the same skills produce
// a veilboard, a sitesthatgetcalls, or anything else, purely from this file.

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './env.mjs';

export const PROJECT_FILE = path.join(PROJECT_ROOT, '.supertools-state', 'project.json');

/**
 * Read `.supertools-state/project.json`.
 *
 * @param {{ required?: boolean }} [opts]
 *   required (default true) — throw a directive error when the file is absent.
 *   Pass `false` in verifiers that must degrade gracefully.
 * @returns {{projectName: string, domain: string|null, brandName: string} | null}
 */
export function readProject({ required = true } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(PROJECT_FILE, 'utf-8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (!required) return null;
    throw new Error(
      `.supertools-state/project.json not found at ${PROJECT_FILE} — run skill 01-project-init first.`
    );
  }

  const j = JSON.parse(raw);
  const projectName = j.projectName || path.basename(PROJECT_ROOT);
  return {
    ...j,
    projectName,
    domain: j.domain || null,
    // Human-facing display name. Explicit `brandName` wins; otherwise
    // title-case the slug: "sites-that-get-calls" → "Sites That Get Calls".
    brandName: j.brandName || titleCase(projectName),
  };
}

/** Require the domain specifically — the common case for DNS/email/deploy skills. */
export function requireDomain() {
  const p = readProject();
  if (!p.domain) {
    throw new Error('project.json has no "domain" — run skill 00-prereqs first.');
  }
  return p.domain;
}

export function titleCase(slug) {
  return String(slug)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)([a-z])/g, (_, s, c) => s + c.toUpperCase());
}

/**
 * Resolve a per-project config file that sits next to a skill, e.g.
 * `config.<projectName>.json`, falling back to `config.example.json`.
 * Lets a skill ship a worked example while each project supplies its own.
 *
 * @param {string} skillDir absolute path to the skill folder
 * @param {string} stem     e.g. "config" or "niche"
 */
export function resolveProjectConfig(skillDir, stem = 'config') {
  const { projectName } = readProject({ required: false }) || {
    projectName: path.basename(PROJECT_ROOT),
  };
  const own = path.join(skillDir, `${stem}.${projectName}.json`);
  if (fs.existsSync(own)) return own;

  const example = path.join(skillDir, `${stem}.example.json`);
  if (fs.existsSync(example)) return example;

  throw new Error(
    `No ${stem} config for "${projectName}" in ${skillDir}. ` +
      `Create ${stem}.${projectName}.json (copy ${stem}.example.json).`
  );
}
