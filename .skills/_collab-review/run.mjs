#!/usr/bin/env node
// _collab-review run.mjs
//
// Usage: node .skills/_collab-review/run.mjs <skill-id> [<skill-id> ...]
//
// Runs a two-model collab review (codex gpt-5.5 high-reasoning + gemini-3-pro-preview)
// in parallel for each named skill. Writes per-skill artifacts under
// .supertools-state/<id>/collab-review-<ts>/. Exits non-zero if any reviewer
// rejects any skill.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = path.join(HERE, 'review-prompt.md');

const log = (...a) => console.log(...a);

// Tail a long log file so the prompt doesn't blow up. Keep tail size honest
// (~6000 chars ≈ ~1500 tokens) so reviewers see the meaningful bit.
// One-paragraph description of what this project is, given to both reviewers.
// Set "context" in .supertools-state/project.json; otherwise a generic line.
function projectContext() {
  const p = readProject({ required: false });
  if (p?.context) return p.context;
  const name = p?.brandName || 'This project';
  return `${name} is the project under review. No longer description was supplied ` +
    '(set "context" in .supertools-state/project.json to give reviewers more).';
}

function tailText(text, max = 6000) {
  if (text.length <= max) return text;
  return '...[truncated head]...\n' + text.slice(-max);
}

async function readMaybe(p) {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}

async function buildPrompt(skillId) {
  const template = await fs.readFile(PROMPT_TEMPLATE, 'utf-8');
  const skillDir = path.join(PROJECT_ROOT, '.skills', skillId);
  const stateDir = path.join(PROJECT_ROOT, '.supertools-state', skillId);
  // Prefer the staged candidate (review-before-finalize); fall back to the
  // finalized receipt (retrospective review of an already-done skill).
  const candidatePath = path.join(PROJECT_ROOT, '.supertools-state', `${skillId}.candidate.json`);
  const finalPath = path.join(PROJECT_ROOT, '.supertools-state', `${skillId}.json`);

  const skillMd     = (await readMaybe(path.join(skillDir, 'SKILL.md')))     ?? '(SKILL.md not found)';
  const requires    = (await readMaybe(path.join(skillDir, 'requires.json'))) ?? '(requires.json not found)';
  const receipt     = (await readMaybe(candidatePath)) ?? (await readMaybe(finalPath)) ?? '(receipt not found)';
  const setupLog    = (await readMaybe(path.join(stateDir, 'setup-output.log')))  ?? '';
  const verifyLog   = (await readMaybe(path.join(stateDir, 'verify-output.log'))) ?? '';

  let stateListing = '(directory missing)';
  try {
    const entries = await fs.readdir(stateDir);
    stateListing = entries.sort().join('\n');
  } catch {}

  return template
    .replaceAll('{{PROJECT_CONTEXT}}',  projectContext())
    .replaceAll('{{SKILL_ID}}',         skillId)
    .replace('{{SKILL_MD}}',            skillMd)
    .replace('{{REQUIRES_JSON}}',       requires)
    .replace('{{RECEIPT_JSON}}',        receipt)
    .replace('{{SETUP_LOG_TAIL}}',      tailText(setupLog))
    .replace('{{VERIFY_LOG_TAIL}}',     tailText(verifyLog))
    .replace('{{STATE_DIR_LISTING}}',   stateListing)
    .replaceAll('{{STATE_DIR_PATH}}',   stateDir)
    .replaceAll('{{SKILL_DIR_PATH}}',   skillDir);
}

function runReviewer({ name, cmd, args, prompt, outputPath, stdinPrompt = true }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const proc = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    proc.stdout.on('data', (b) => stdoutChunks.push(b));
    proc.stderr.on('data', (b) => stderrChunks.push(b));
    proc.on('close', async (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const elapsedMs = Date.now() - startedAt;
      const header = `--- reviewer: ${name} ---\n--- cmd: ${cmd} ${args.join(' ')} ---\n` +
                     `--- exit ${code}, elapsed ${Math.round(elapsedMs/1000)}s ---\n`;
      await fs.writeFile(outputPath, header + '\n--- stdout ---\n' + stdout + '\n--- stderr ---\n' + stderr);
      // Verdict parse: look for the last APPROVED/REJECTED token in stdout
      const lastLine = stdout.trim().split(/\r?\n/).reverse()
        .find((l) => /COLLAB_REVIEW_(APPROVED|REJECTED)/.test(l)) || '';
      const verdict = /REJECTED/.test(lastLine) ? 'rejected'
                    : /APPROVED/.test(lastLine) ? 'approved'
                    : 'unclear';
      resolve({ name, exitCode: code, elapsedMs, verdict, outputPath, stdout });
    });
    if (stdinPrompt) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }
  });
}

async function reviewSkill(skillId) {
  log(`▶ ${skillId}: spawning codex + gemini in parallel...`);
  const stateDir = path.join(PROJECT_ROOT, '.supertools-state', skillId);
  await fs.mkdir(stateDir, { recursive: true });
  const ts = Math.floor(Date.now() / 1000);
  const reviewDir = path.join(stateDir, `collab-review-${ts}`);
  await fs.mkdir(reviewDir, { recursive: true });

  const prompt = await buildPrompt(skillId);
  await fs.writeFile(path.join(reviewDir, 'prompt.txt'), prompt);

  const codexArgs = [
    'exec',
    '--cd', PROJECT_ROOT,
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', process.env.COLLAB_CODEX_MODEL || 'gpt-5.5',
    '-c', `model_reasoning_effort=${process.env.COLLAB_CODEX_EFFORT || 'high'}`,
    '-',
  ];
  const geminiArgs = [
    '-p', prompt,
    // gemini-3-pro-preview is the best model this CLI serves (verified 2026-07-03;
    // gemini-3.1-pro 404s). Falls back via env override if it's ever retired.
    '-m', process.env.COLLAB_GEMINI_MODEL || 'gemini-3-pro-preview',
    '-y',
  ];

  const [codex, gemini] = await Promise.all([
    runReviewer({
      name: 'codex',
      cmd: 'codex',
      args: codexArgs,
      prompt,
      outputPath: path.join(reviewDir, 'codex.log'),
      stdinPrompt: true,
    }),
    runReviewer({
      name: 'gemini',
      cmd: 'gemini',
      args: geminiArgs,
      prompt: '',
      outputPath: path.join(reviewDir, 'gemini.log'),
      stdinPrompt: false,
    }),
  ]);

  const overall = (codex.verdict === 'approved' && gemini.verdict === 'approved') ? 'approved' : 'rejected';

  const summary = {
    skillId,
    timestamp: new Date().toISOString(),
    overallVerdict: overall,
    reviewers: {
      codex:  { verdict: codex.verdict,  exitCode: codex.exitCode,  elapsedSec: Math.round(codex.elapsedMs / 1000),  log: codex.outputPath },
      gemini: { verdict: gemini.verdict, exitCode: gemini.exitCode, elapsedSec: Math.round(gemini.elapsedMs / 1000), log: gemini.outputPath },
    },
    reviewDir,
  };
  await fs.writeFile(path.join(reviewDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  log(`  ${skillId}: codex=${codex.verdict} (${summary.reviewers.codex.elapsedSec}s) · gemini=${gemini.verdict} (${summary.reviewers.gemini.elapsedSec}s) · overall=${overall}`);
  return summary;
}

async function main() {
  loadEnv();
  const skillIds = process.argv.slice(2);
  if (skillIds.length === 0) {
    console.error('Usage: node .skills/_collab-review/run.mjs <skill-id> [<skill-id> ...]');
    process.exit(1);
  }
  log(`▶ Collab-reviewing ${skillIds.length} skill(s) in parallel: ${skillIds.join(', ')}`);

  const results = await Promise.all(skillIds.map(reviewSkill));

  log('\n=== SUMMARY ===');
  for (const r of results) {
    log(`  ${r.skillId}: ${r.overallVerdict}  (codex=${r.reviewers.codex.verdict}, gemini=${r.reviewers.gemini.verdict})`);
    log(`    ${r.reviewDir}`);
  }
  const anyRejected = results.some((r) => r.overallVerdict !== 'approved');
  log(`\nOverall: ${anyRejected ? 'AT LEAST ONE SKILL REJECTED' : 'ALL APPROVED'}`);
  process.exit(anyRejected ? 1 : 0);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
