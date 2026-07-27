# Skill workflow

The standard lifecycle every numbered skill (`00` … `17`) follows. Read this
before authoring or running a skill.

## The starting assumption: Design OS is already done

**This pipeline begins where Design OS's `/export-product` ends.** Every run
assumes `design/product-plan/` exists and is complete, and treats it as the
canonical source for anything that describes the product's brand:

| What | Where it comes from |
|---|---|
| palette | `design/product-plan/design-system/tokens.css` |
| typography | `tokens.css` `--font-*`, else the role table in `fonts.md` |
| webfonts to load | the Google Fonts sheet in `design-system/fonts.md` |
| stock Tailwind palette names | `design-system/tailwind-colors.md` |
| application shell components | `design/product-plan/shell/components/` |
| product name + summary | `design/product-plan/product-overview.md` |

`00-prereqs` enforces this: it fails, loudly and before any credential check,
unless `product-overview.md`, `design-system/tokens.css`,
`design-system/fonts.md`, and `shell/components/AppShell.tsx` all exist AND
the export actually yields font stacks and a primary colour. There is no
degraded mode and no fallback brand.

**Rule for anyone editing a skill: no skill may embed a colour, a font, a
tagline, or a component list of its own.** Read it from the export through
`_shared/design-os.mjs`, or from `.supertools-state/project.json` — and if the
project supplies neither, fail or omit. Substituting a plausible default is
how this repo previously shipped one reference brand's fonts and copy into
every project built with it. Verifiers are held to the same rule: assert
consistency with the project's own export, never a named font or hex.

### Not yet converted — known brand leaks

Skills `00`–`04` follow the rule above. These do not, and will render in the
reference implementation's brand until someone fixes them:

| Where | What leaks |
|---|---|
| `08-support-chat/setup.mjs` | `const ROSE = '#881337'` as the Chatwoot widget colour — should be the export's `--color-primary` |
| `09-forms/templates/SupportForm.tsx` | `rose-*` / `stone-*` / `emerald-*` Tailwind classes and an inline `Fraunces` font-family |
| `11-legal-pages/templates/*.tmpl` | `prose-stone` / `stone-*` classes; `terms.tsx.tmpl` also describes "wedding-aesthetic image artifacts" as the product |
| `seo-04-page-build/template.mjs`, `seo-05-internal-links/setup.mjs` | `rose-*` / `stone-*` classes and `font-serif` headings throughout the generated page shell |
| `_shared/competitors.mjs` | a wedding-industry competitor blocklist, used by the SEO track for every project |

The `seo-*` `config.example.json` / `niche.example.json` files and
`DECISIONS.example.md` are **not** leaks — they are deliberately kept as
worked examples (see "Project identity" below).

## The skills, at a glance

Three tracks live here. The **numbered bootstrap pipeline** (`00`–`17`) takes a
bare repo to a live, verified app. The **SEO growth track** (`seo-*`) builds the
ranking-page surface and runs *after* launch. Two **meta-skills** are invoked
ad hoc against any artifact, not as pipeline steps.

### Bootstrap pipeline (`00`–`17`) — runs in dependency order

```
00 prereqs ─┬─ 01 init ─ 02 design-tokens ─ 03 shell ─ 04 logo
            │              ├─ 09 forms · 10 analytics · 11 legal · 13 uptime
            ├─ 05 domain-dns ─┬─ 06 email-transactional
            │                 ├─ 07 email-mailboxes ─ 08 support-chat ─ 09 forms
            │                 └─ 12 payments
            └─ 14 ralph-harness ─ 15 ralph-plan ─ 16 ralph-build ─ 17 launch-verify
```

| ID | Provides |
|----|----------|
| 00-prereqs           | Design OS export gate + credential / CLI / domain gate for every later skill |
| 01-project-init      | TanStack Start + CF Workers scaffold, git repo |
| 02-design-tokens     | the export's palette + fonts + CSS vars into Tailwind 4 |
| 03-shell             | the shell components the export ships, wired to the router |
| 04-logo              | SVG wordmark + favicon/OG set, drawn in the export's brand |
| 05-domain-dns        | Cloudflare CAA baseline |
| 06-email-transactional | Ahasend send domain + SPF/DKIM/DMARC + send key |
| 07-email-mailboxes   | MXroute support@ / privacy@ mailboxes + inbound DNS |
| 08-support-chat      | Chatwoot account + website widget + email inboxes |
| 09-forms             | /api/contact + /api/privacy → Chatwoot |
| 10-analytics         | Rybbit snippet + typed event taxonomy |
| 11-legal-pages       | /terms, /privacy, /refund |
| 12-payments          | Polar sandbox products + order webhook |
| 13-uptime            | Healthchecks heartbeat + /api/health |
| 14-ralph-harness     | local 3-agent council build engine (plan + build councils) |
| 15-ralph-plan        | plan-council → approved tasks.json (unanimous gate) |
| 16-ralph-build       | build-council loop → built app, live deploy |
| 17-launch-verify     | live end-to-end smoke of the project domain → launch report |

### SEO growth track (`seo-*`) — post-launch, its own dependency chain

```
seo-01-keyword-discovery ─ seo-01b-content-map ─ seo-02-serp-briefs ─┬─ seo-03-page-images
                                                                     └─ seo-04-page-build ─ seo-05-internal-links
```

(`seo-04` consumes both the briefs and the images; `seo-05` injects the
content-map link graph into the built pages.) This track follows the same
SKILL/requires/setup/verify contract as the numbered skills, but is keyed by
`seo-*` rather than the bootstrap sequence and is not part of the launch gate.

### Meta-skills — invoked ad hoc, not pipeline steps

- **`_collab-review`** — two-model independent quality gate (see step 6 below).
- **`icp-focus-group`** — 3-model ICP panel that scores any artifact. Has
  `run.mjs` + `SKILL.md` only (no requires/setup/verify) — it's a tool you run,
  not a pipeline stage.

## Folder conventions

```
.skills/
├── WORKFLOW.md            ← this file
├── _shared/               ← shared helpers (env, state, cli, repos, council, API clients)
│   ├── design-os.mjs      the ONLY reader of design/product-plan/ — palette,
│   │                      fonts, shell file list, product name + summary
│   └── project.mjs        the ONLY reader of project.json — name, brand, domain
├── _collab-review/        ← meta-skill: two-model independent review
├── icp-focus-group/       ← meta-skill: 3-model ICP scoring panel
├── NN-name/               ← one numbered bootstrap skill per pipeline step (00–17)
│   ├── SKILL.md           human-readable intent (the operative doc)
│   ├── requires.json      deps: requires[], envRequired[], cliRequired[], provides[]
│   ├── setup.mjs          does the work; idempotent; prints ---SETUP_DONE--- + JSON
│   └── verify.mjs         programmatic smoke test; exit 0 = pass
└── seo-NN-name/           ← SEO growth-track skills (same contract, seo-* keyed)
```

All intermediate data, raw API dumps, logs, prompts, and reports live under
`.supertools-state/<id>/`. The finalized receipt is `.supertools-state/<id>.json`.

## Project identity — the reuse seam

Nothing in `.skills/` may hardcode a project name, brand name, or domain. All
three come from `.supertools-state/project.json`, read through one accessor
(the brand's *look* comes from the Design OS export — see the starting
assumption above — and is read through `_shared/design-os.mjs`):

```js
import { readProject, requireDomain, resolveProjectConfig } from '../_shared/project.mjs';

const { projectName, brandName, domain } = readProject();
const d = requireDomain();                            // throws if unset
const cfg = resolveProjectConfig(HERE, 'config');     // config.<projectName>.json → config.example.json
```

`project.json` is written by `00-prereqs`, which reads `brandName` and
`context` out of the export's `product-overview.md`:

```json
{
  "projectName": "acme-plumbing",
  "domain": "acmeplumbing.com",
  "brandName": "Acme Plumbing",
  "context": "One paragraph describing the product, given to council reviewers."
}
```

`brandName` falls back to a title-cased `projectName` only if the export's
overview has no H1. `context` feeds `{{PROJECT_CONTEXT}}` in the
`_collab-review` prompt, and is also the `<meta name="description">` and OG
card copy in `04-logo` — so it is the project's own words or nothing.

Skills that need richer per-project settings (the whole `seo-*` track) ship a
`config.example.json` next to the skill. Copy it to `config.<projectName>.json`
and edit — `resolveProjectConfig()` prefers yours and falls back to the example.
The example files are the reference implementation's, kept as worked examples;
they are not defaults you should ship.

Two skills need extra per-project input beyond `project.json`:

| Skill | What to supply |
|-------|----------------|
| `14-ralph-harness` | scaffolds `.agent/DECISIONS.md` from `DECISIONS.template.md`. Fill it in and delete the `> **UNFILLED**` line — `15-ralph-plan` refuses to run until you do. See `DECISIONS.example.md` for the expected depth. |
| `15-ralph-plan` | `PLAN_POC_DIR` (optional) — absolute path to a proof-of-concept the plan council should read. |

`17-launch-verify` smoke-tests `LAUNCH_ROUTES` (comma-separated, default
`/,/terms,/privacy,/refund,/contact,/privacy-request`) and probes the apex→www
redirect with `LAUNCH_PROBE_PATH` (default `/`).

## The lifecycle (per skill)

1. **Write / review SKILL.md** — keep it simple and human-readable. The user
   reviews this before the skill runs.
2. **setup.mjs** — perform the work. Must be idempotent (no-op or safe re-run
   if already done). Print a `---SETUP_DONE---` block with a JSON summary.
3. **verify.mjs** — probe the result programmatically. Never "ask" whether it
   worked; check it. Substantive checks, not shallow existence tests.
4. **Stage candidate receipt** at `.supertools-state/<id>.candidate.json`.
5. **In-line council** (`_shared/council.md`) — fast `codex exec` acceptance
   check. Fix + re-stage on rejection (≤3 rounds).
6. **Collab review** (`_collab-review`) — the deeper gate. Run:
   ```sh
   node .skills/_collab-review/run.mjs <id>
   ```
   Two independent reviewers (codex gpt-5.5 high-reasoning + gemini-2.5-pro)
   review in parallel. **Both must approve.** This is a hard gate.
7. **On rejection** — do NOT just patch the output. Refine the *skill itself*
   (SKILL.md / setup.mjs / verify.mjs / criteria) so the issue can't recur,
   then re-run from step 2. The collab reviewers' "recommendations for
   refining the underlying skill" section names exactly what to change.
8. **Finalize** — rename candidate → `.supertools-state/<id>.json` only after
   both the in-line council and the collab review approve.

## Why two review layers

- **In-line council** is a fast per-skill acceptance check during authoring.
- **Collab review** is the independent, two-model "step back" audit. It has
  repeatedly caught systemic issues the council + verifier passed: hardcoded
  paths, unenforced idempotency, dishonest gates, brand drift. Treat its
  rejections as signal about the *skill design*, not just this run's output.

## Quality bars (what reviewers check)

- **Correctness** — does it do what SKILL.md claims? Verifier substantive?
- **Completeness** — gaps between promise and delivery?
- **Robustness** — fresh project, empty caches, partial re-runs, offline?
- **Clarity** — SKILL.md simple + honest, especially failure-mode tables?
- **Reproducibility** — works on any machine; no hardcoded absolute paths,
  no machine-specific assumptions.
- **Honesty** — receipts never overclaim; deferred work is named as deferred.

## Portability rules (learned the hard way)

- Never hardcode an absolute project path. Use `PROJECT_ROOT` from
  `_shared/env.mjs` (portable: derived from module location).
- External repos (supertools-stack, etc.) clone from GitHub into
  `.supertools-state/_cache/`, pinned to main, SHA recorded in the receipt.
- Gate any mandatory external-tool dependency honestly: if a required CLI is
  missing, fail loud — don't silently skip and claim success.
