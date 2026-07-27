// Read and write skill receipts under <project>/.supertools-state/.
// Each skill writes <id>.json on success; the orchestrator-equivalent reads
// <id>.json to know the skill ran cleanly.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from './env.mjs';

export const STATE_DIR = path.join(PROJECT_ROOT, '.supertools-state');

async function ensureStateDir() {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

export async function readState(name) {
  try {
    const text = await fs.readFile(path.join(STATE_DIR, `${name}.json`), 'utf-8');
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeState(name, body) {
  await ensureStateDir();
  await fs.writeFile(
    path.join(STATE_DIR, `${name}.json`),
    JSON.stringify(body, null, 2) + '\n'
  );
}

export async function writeReceipt(id, summary, extra = {}) {
  await writeState(id, {
    status: 'ok',
    version: '0.1',
    timestamp: new Date().toISOString(),
    summary,
    ...extra,
  });
}

// Cross-skill handoff: skills that set things up which the Worker itself must
// implement (e.g. naked→www redirect, webhook handlers, health pings) append
// a requirement here. Skill 14 (ralph-plan) reads this accumulator so those
// requirements become explicit tasks in the implementation plan.
//
// Idempotent by (skillId, key): re-running a skill replaces its own entry
// for that key rather than duplicating.
export async function appendRalphRequirement(skillId, key, requirement) {
  await ensureStateDir();
  const file = path.join(STATE_DIR, 'ralph-requirements.json');
  let list = [];
  try { list = JSON.parse(await fs.readFile(file, 'utf-8')); } catch {}
  if (!Array.isArray(list)) list = [];
  const idx = list.findIndex((r) => r.skillId === skillId && r.key === key);
  const entry = { skillId, key, requirement, updatedAt: new Date().toISOString() };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  await fs.writeFile(file, JSON.stringify(list, null, 2) + '\n');
  return entry;
}
