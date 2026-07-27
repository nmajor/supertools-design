#!/usr/bin/env node
// ICP focus group: 3 model backends (codex gpt-5.5, gemini-2.5-pro, claude) each
// role-play an ICP persona and score an artifact on defined scales. Quantified
// answers are parsed + aggregated so verdicts can be compared across models.
//
// Usage: node run.mjs <config.json>
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const configPath = process.argv[2]
if (!configPath) {
  console.error('usage: node run.mjs <config.json>')
  process.exit(2)
}
const cfg = JSON.parse(await readFile(configPath, 'utf8'))
if (!cfg.topic || !Array.isArray(cfg.questions) || cfg.questions.length === 0) {
  console.error('config needs { topic, questions:[{id,text,scale}], persona, images? }')
  process.exit(2)
}
const images = (cfg.images || []).map((p) => path.resolve(p))
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve('.supertools-state/icp-focus-group', ts)
await mkdir(outDir, { recursive: true })

function buildPrompt(persona, { withRead = false, withAt = false } = {}) {
  const qlines = cfg.questions
    .map((q, i) => `  ${i + 1}. [id: ${q.id}] ${q.text}  — rate on ${q.scale}; give the number + a one-line reason.`)
    .join('\n')
  const imgRef = images.length
    ? withAt
      ? `\nImages to review: ${images.map((p) => '@' + p).join(' ')}\n`
      : withRead
        ? `\nFIRST, use your Read tool to VIEW each of these image(s): ${images.join(', ')}\n`
        : `\n(Image(s) are attached to this message — look at them carefully.)\n`
    : ''
  return `You are role-playing a SPECIFIC REAL PERSON, not an AI assistant. Stay fully in character the whole time.

PERSONA: ${persona}

You are assessing: ${cfg.topic}
${imgRef}
Answer AS THIS PERSON — candid, concise, in your own voice. For EACH question give the numeric rating on its stated scale plus a one-line reason:
${qlines}

Then end your reply with ONE final line, exactly this format (valid JSON, no markdown fence):
FOCUS_GROUP_JSON: {"scores": {${cfg.questions.map((q) => `"${q.id}": <number>`).join(', ')}}, "overall": <number 1-10>, "verdict": "<2-4 sentence verdict in your voice>"}

Be brutally honest. Do NOT edit, create, or modify any files — only reply.`
}

function run({ name, cmd, args, stdin, outPath }) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: process.cwd() })
    let out = '', err = ''
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', (e) => resolve({ name, ok: false, raw: String(e), parsed: null }))
    proc.on('close', async (code) => {
      const raw = out + (err ? `\n--- stderr ---\n${err}` : '')
      await writeFile(outPath, `# ${name}  (exit ${code})\n\n${raw}\n`)
      resolve({ name, ok: code === 0, raw, parsed: parseJson(raw) })
    })
    if (stdin != null) { proc.stdin.write(stdin); proc.stdin.end() }
  })
}

function parseJson(text) {
  // Scan per-line and keep the LAST line that both tags + parses. codex echoes
  // the prompt (which contains the FOCUS_GROUP_JSON template with `<number>`
  // placeholders), so a greedy multi-line match would grab the invalid template
  // — the real answer is a single valid JSON line emitted last.
  let found = null
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/FOCUS_GROUP_JSON:\s*(\{.*\})\s*$/)
    if (m) { try { found = JSON.parse(m[1]) } catch { /* template/placeholder line */ } }
  }
  if (found) return found
  // fallback: last self-contained {...} object mentioning "overall"
  const all = [...text.matchAll(/\{[^{}]*"overall"[^{}]*\}/g)]
  for (let i = all.length - 1; i >= 0; i--) { try { return JSON.parse(all[i][0]) } catch { /* keep looking */ } }
  return null
}

const persona = cfg.persona || 'A typical target customer for this product.'
const pp = cfg.panelistPersonas || {}

const codexPrompt = buildPrompt(pp.codex || persona, {})
const geminiPrompt = buildPrompt(pp.gemini || persona, { withAt: true })
const claudePrompt = buildPrompt(pp.claude || persona, { withRead: true })

console.log(`▶ ICP focus group: codex + gemini + claude on "${cfg.topic.slice(0, 60)}"...`)
const panel = await Promise.all([
  run({
    name: 'codex', cmd: 'codex',
    args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort=high',
      ...images.flatMap((p) => ['-i', p])],
    stdin: codexPrompt, outPath: path.join(outDir, 'codex.log'),
  }),
  run({
    name: 'gemini', cmd: 'gemini',
    args: ['-m', 'gemini-2.5-pro', '-y', '-p', geminiPrompt],
    stdin: null, outPath: path.join(outDir, 'gemini.log'),
  }),
  run({
    name: 'claude', cmd: 'claude',
    args: ['-p', claudePrompt],
    stdin: null, outPath: path.join(outDir, 'claude.log'),
  }),
])

// aggregate
const ids = cfg.questions.map((q) => q.id)
const agg = {}
for (const id of [...ids, 'overall']) {
  const vals = panel.map((p) => p.parsed && (id === 'overall' ? p.parsed.overall : p.parsed.scores?.[id]))
    .filter((v) => typeof v === 'number')
  if (vals.length) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    agg[id] = { mean: +mean.toFixed(2), min: Math.min(...vals), max: Math.max(...vals), n: vals.length,
      consensus: Math.max(...vals) - Math.min(...vals) <= 2 }
  } else agg[id] = { mean: null, n: 0 }
}

const summary = {
  topic: cfg.topic, ts, images,
  panelists: panel.map((p) => ({ name: p.name, ok: p.ok, parsed: p.parsed })),
  aggregate: agg,
}
await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')

// report.md
let md = `# ICP focus group — ${cfg.topic}\n\n_${ts}_\n\n## Scores\n\n`
md += `| Question | ${panel.map((p) => p.name).join(' | ')} | mean | spread |\n|${'---|'.repeat(panel.length + 3)}\n`
for (const q of cfg.questions) {
  const row = panel.map((p) => p.parsed?.scores?.[q.id] ?? '—')
  md += `| ${q.text} | ${row.join(' | ')} | ${agg[q.id].mean ?? '—'} | ${agg[q.id].consensus ? 'consensus' : 'split'} |\n`
}
const orow = panel.map((p) => p.parsed?.overall ?? '—')
md += `| **OVERALL** | ${orow.join(' | ')} | **${agg.overall.mean ?? '—'}** | ${agg.overall.consensus ? 'consensus' : 'split'} |\n\n## Verdicts\n\n`
for (const p of panel) md += `### ${p.name}\n\n${p.parsed?.verdict || '(could not parse — see ' + p.name + '.log)'}\n\n`
await writeFile(path.join(outDir, 'report.md'), md)

console.log(`  done → ${outDir}`)
console.log(`  overall mean: ${agg.overall.mean ?? 'n/a'} (${agg.overall.n}/3 parsed)` +
  panel.map((p) => `  ${p.name}=${p.parsed?.overall ?? '?'}`).join(''))
