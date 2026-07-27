---
name: _collab-review
description: Two-model independent quality review of a project skill — codex (gpt-5.5, high reasoning) and gemini (3-pro-preview) review in parallel. Hard gate — either reviewer rejecting demotes the skill's receipt; findings drive refinement of the skill itself, not just the output.
---

# Collab review (meta-skill)

A meta-skill that you call **on other skills**. Runs two independent
reviewers — codex with gpt-5.5 at high reasoning effort, and gemini-3-pro-preview
— in parallel against a target skill's SKILL.md, requires.json, receipt,
and raw outputs. Returns approve/reject from each, plus structured findings.

This is the project's quality backstop. The in-line codex council each
skill already runs is a fast acceptance check; this skill is the deeper
"step back and think" review that catches systemic / structural issues.

## When to run

- **Retrospectively** on any prior skill whose quality you want to audit.
- **After every future skill** completes its in-line council. The new
  default is: skill setup → verifier → in-line codex council → collab-review.
  If either reviewer rejects, the receipt is treated as non-final and the
  underlying skill itself must be refined and re-run.

## Verdict authority

Hard gate. Either reviewer's `COLLAB_REVIEW_REJECTED` blocks finalization.
The fix is **not** to patch outputs locally — it's to refine the skill's
SKILL.md / setup.mjs / verify.mjs / criteria so the issue can't reappear,
then re-run the skill itself.

Findings are categorized in the prompt as `BLOCKING` or `POLISH`; reviewers
should reject only on blocking-grade issues.

## Inputs

- Target skill ID (matches the folder under `.skills/`).
- The target skill's:
  - `SKILL.md`, `requires.json`
  - Final receipt at `.supertools-state/<id>.json`
  - Setup + verifier output logs
  - Raw state directory listing

Reviewers have shell + file-read tool access, so they can pull more files
on their own when the headline artifacts don't tell the full story.

## Usage

```sh
# Single skill
node .skills/_collab-review/run.mjs 04-logo

# Many in parallel (10 concurrent processes total, ~60-180s wall time)
node .skills/_collab-review/run.mjs 00-prereqs 01-project-init 02-design-tokens 03-shell 04-logo
```

## Output

Per skill, under `.supertools-state/<id>/collab-review-<ts>/`:

- `prompt.txt` — the full prompt both reviewers saw
- `codex.log` — codex's reasoning + verdict (`COLLAB_REVIEW_APPROVED` or `…REJECTED`)
- `gemini.log` — gemini's reasoning + verdict
- `summary.json` — both verdicts + run metadata

Process exits 0 if every reviewed skill got both APPROVED, 1 if any rejected.

## Idempotency

Re-runnable. Each run lands in its own timestamped `collab-review-<ts>/`
subdir; nothing is overwritten. Multiple reviews per skill build up an
audit history.

## Common failure modes

| Symptom | Fix |
|---|---|
| Reviewer verdict reported as `unclear` | The model didn't emit a `COLLAB_REVIEW_APPROVED` / `…REJECTED` token at the end. Re-run; if persistent, tighten the verdict-format instruction in `review-prompt.md`. |
| `gemini` exits non-zero with auth error | `gemini auth login` once interactively. |
| `codex` hangs on long prompts | Same fix as for the existing in-line council: prompt is already piped via stdin (with `-` as the positional sentinel). |
| Both reviewers approve but findings list real issues | The verdict is a coarse signal — read the logs. The whole point of polish-vs-blocking categorization is to capture real-but-non-blocking findings. |
