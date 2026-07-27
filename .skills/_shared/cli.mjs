// Shared invocations of the claude and codex CLIs.
// Flag shapes match ralph-driven-development-agent-brief.md so every skill
// drives both council sides through one helper.

import { execSync, spawnSync } from 'node:child_process';

export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
export const CODEX_BIN = process.env.CODEX_BIN || 'codex';
export const GEMINI_BIN = process.env.GEMINI_BIN || 'gemini';
export const CLAUDE_MODEL = process.env.RALPH_CLAUDE_MODEL || 'opus';
export const CODEX_MODEL = process.env.RALPH_CODEX_MODEL || 'gpt-5.5';
// Best model this gemini CLI serves (verified 2026-07-03; gemini-3.1-pro 404s).
export const GEMINI_MODEL = process.env.RALPH_GEMINI_MODEL || 'gemini-3-pro-preview';

function which(bin) {
  // Plain binary lookup — no shell:true (avoids the DEP0190 deprecation noise).
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export function hasCli(bin) { return Boolean(which(bin)); }

export function claudePing() {
  return spawnSync(CLAUDE_BIN, ['-p', 'Reply with OK.', '--model', CLAUDE_MODEL,
    '--permission-mode', 'bypassPermissions'], { encoding: 'utf-8' });
}

export function codexPing(cwd = process.cwd()) {
  return spawnSync(CODEX_BIN, ['exec', '--cd', cwd, '--model', CODEX_MODEL,
    '--dangerously-bypass-approvals-and-sandbox', 'Reply with OK.'],
    { encoding: 'utf-8' });
}

export function geminiPing() {
  return spawnSync(GEMINI_BIN, ['-p', 'Reply with OK.', '-m', GEMINI_MODEL, '-y'],
    { encoding: 'utf-8' });
}

export function claudeP(prompt, opts = {}) {
  const args = ['-p', prompt, '--model', CLAUDE_MODEL,
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json', '--verbose'];
  return spawnSync(CLAUDE_BIN, args, {
    encoding: 'utf-8',
    cwd: opts.cwd || process.cwd(),
    stdio: opts.inherit ? 'inherit' : 'pipe',
    maxBuffer: 50 * 1024 * 1024,
  });
}

export function codexExec(prompt, opts = {}) {
  // Long prompts (~5KB+) lock codex into stdin mode when passed via argv.
  // Always pipe via stdin and use `-` as the positional prompt sentinel.
  const cwd = opts.cwd || process.cwd();
  const args = ['exec', '--cd', cwd, '--model', CODEX_MODEL,
    '--dangerously-bypass-approvals-and-sandbox', '-'];
  return spawnSync(CODEX_BIN, args, {
    encoding: 'utf-8',
    cwd,
    input: prompt,
    stdio: opts.inherit ? ['pipe', 'inherit', 'inherit'] : 'pipe',
    maxBuffer: 50 * 1024 * 1024,
  });
}
