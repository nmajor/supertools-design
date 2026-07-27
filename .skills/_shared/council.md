# Council review template

Every skill ends with a Codex review of its candidate receipt. Codex is the
adversarial reviewer; the in-session Claude is the implementer. The contract
is the same for every skill so the loop is uniform.

## Steps the skill performs

1. Stage `.supertools-state/<id>.candidate.json` with the receipt body the
   skill produced (status, summary, plus skill-specific fields).
2. Build the review prompt below, substituting the bracketed fields.
3. Run `codex exec --cd "$PROJECT_ROOT" --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox "$PROMPT"`.
4. Codex must end its reply with exactly one of:
   - `COUNCIL_APPROVED`
   - `COUNCIL_REJECTED` followed by a numbered list of blocking findings.
5. On `COUNCIL_REJECTED`, fix every finding, re-stage the candidate, and
   re-review. Max 3 review rounds total.
6. On `COUNCIL_APPROVED`, rename candidate → `.supertools-state/<id>.json`.
7. If the third round still rejects, halt and surface the findings to the
   user. Do NOT mark the receipt approved.

## Reviewer prompt skeleton

```
You are the adversarial reviewer for project skill <id>.

Read the skill's intent:
[paste the full contents of .skills/<id>/SKILL.md]

Read the skill's contract:
[paste .skills/<id>/requires.json]

Files the skill wrote or changed in this run:
[bulleted list of absolute paths]

Candidate receipt the skill is about to finalize:
[the staged .supertools-state/<id>.candidate.json verbatim]

The project keeps its review standards in `.skills/_shared/authoring-checklist.md`
(numbered rules distilled from prior rejections). Enforce them — cite rule
numbers in findings where applicable.

Reject if any of these hold:
- The candidate claims a status that the listed files do not actually demonstrate.
- A check listed in SKILL.md is missing from the run (e.g. an API probe that
  was supposed to happen but you can't see evidence of).
- An env key in requires.json was not verified.
- The skill left the project in a worse state than it found it
  (e.g. broken build, half-applied DNS).
- A post-condition in SKILL.md is unverifiable from the artifacts.

Be specific. Reference file paths and line numbers when applicable.

Secret hygiene (hard rule): .env holds real credentials. NEVER print, cat, or
grep-with-output values from .env or any secret in your commands or findings —
reference keys by NAME only. Your transcript is saved to disk as an artifact.

Output exactly one of:
- COUNCIL_APPROVED
- COUNCIL_REJECTED
  1. ...
  2. ...
```
