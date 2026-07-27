# supertools-design

An opinionated, council-reviewed **bootstrap pipeline** that takes a finished
[Design OS](https://github.com/buildermethods/design-os) plan and a bare repo to
a live, verified, SEO-ready app on Cloudflare Workers — without a human wiring
up DNS, email, analytics, payments, uptime, or legal pages by hand.

It is the orchestration half of a two-repo system:

| Repo | Role |
| --- | --- |
| **supertools-design** (this repo) | The pipeline: numbered skills that *decide and wire up* each concern. |
| [**supertools-stack**](https://github.com/nmajor/supertools-stack) | The app template the pipeline scaffolds from (TanStack Start + CF Workers + D1 + Drizzle + Better Auth). |

## What it adds on top of Design OS

Design OS gets you to: product overview, roadmap, data shape, design system,
screen designs, and an export package. It deliberately leaves implementation
choices to the agent that picks up the export. supertools-design picks up there
and bakes in opinionated defaults so the next step can be a hands-off loop.

## The pipeline

Three tracks live in `.skills/`.

### Bootstrap (`00`–`17`) — runs in dependency order

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
| `00-prereqs` | credential / CLI / domain gate for every later skill |
| `01-project-init` | app scaffold from supertools-stack, git repo, `project.json` |
| `02-design-tokens` | palette + fonts + CSS custom properties into Tailwind 4 |
| `03-shell` | AppShell + MainNav + UserMenu + Footer |
| `04-logo` | SVG wordmark + favicon / apple-touch / OG set |
| `05-domain-dns` | Cloudflare CAA baseline |
| `06-email-transactional` | send domain + SPF/DKIM/DMARC + verified send key |
| `07-email-mailboxes` | real mailboxes + inbound DNS |
| `08-support-chat` | support account + website widget + email inboxes |
| `09-forms` | `/api/contact` + `/api/privacy` wired to the support inbox |
| `10-analytics` | analytics snippet + typed event taxonomy |
| `11-legal-pages` | `/terms`, `/privacy`, `/refund` |
| `12-payments` | sandbox products + order webhook |
| `13-uptime` | heartbeat check + `/api/health` |
| `14-ralph-harness` | local 3-agent council build engine |
| `15-ralph-plan` | plan council → approved `tasks.json` (unanimous gate) |
| `16-ralph-build` | build-council loop → built app, live deploy |
| `17-launch-verify` | live end-to-end smoke → launch report |

### SEO growth track (`seo-*`) — post-launch

```
seo-01-keyword-discovery ─ seo-01b-content-map ─ seo-02-serp-briefs ─┬─ seo-03-page-images
                                                                     └─ seo-04-page-build ─ seo-05-internal-links
```

### Meta-skills — run ad hoc against any artifact

- **`_collab-review`** — two-model independent quality gate.
- **`icp-focus-group`** — 3-model ICP panel that scores an artifact on defined scales.

## Skill contract

Every numbered skill is a folder with the same four files:

```
NN-name/
├── SKILL.md        human-readable intent (the operative doc)
├── requires.json   requires[], envRequired[], cliRequired[], provides[]
├── setup.mjs       does the work; idempotent; prints ---SETUP_DONE--- + JSON
└── verify.mjs      programmatic smoke test; exit 0 = pass
```

Receipts land in `<project>/.supertools-state/<id>.json`; intermediate data,
logs, and reports in `<project>/.supertools-state/<id>/`. A skill finalizes only
after both its `verify.mjs` and `_collab-review` pass.

Read [`.skills/WORKFLOW.md`](.skills/WORKFLOW.md) before authoring or running
anything, and [`.skills/_shared/authoring-checklist.md`](.skills/_shared/authoring-checklist.md)
before writing a new skill — it is distilled from real council rejections.

## Project identity

No skill hardcodes a project name, brand, or domain. All three come from
`<project>/.supertools-state/project.json`, read through `_shared/project.mjs`:

```json
{
  "projectName": "acme-plumbing",
  "domain": "acmeplumbing.com",
  "brandName": "Acme Plumbing",
  "context": "One paragraph describing the product, given to council reviewers."
}
```

`brandName` defaults to a title-cased `projectName`. Skills needing richer
settings (the `seo-*` track) ship a `config.example.json`; copy it to
`config.<projectName>.json` and edit. The `*.example.json` files are the
reference implementation's, kept as worked examples — not defaults to ship.

## Install

Bootstrap a new project:

```sh
curl -fsSL https://raw.githubusercontent.com/nmajor/supertools-design/main/install.sh | bash -s acme
```

That creates `acme-design/` containing a clone of Design OS plus supertools-design
wired into `.claude/`. Finish the Design OS flow first — including the export step
that produces `product-plan/` — then:

```sh
cd acme-design
claude
```

```
/supertools-design:start      # initialize and step through workflows
```

The Design OS gate is enforced in every command.

## Workflow commands

| Command | Output |
| --- | --- |
| `/supertools-design:start` | Initialize the tracker, brief on what's coming |
| `/supertools-design:status` | Running tally — what's done, what's next |
| `/supertools-design:bootstrap` | Walk the numbered skills to apply defaults |
| `/supertools-design:logo` | Brand logo, favicon, iOS icons, variations |
| `/supertools-design:tech-stack` | Framework, hosting, deployment decisions |
| `/supertools-design:apis` | Third-party API list + working POC scripts |
| `/supertools-design:analytics` | Analytics stack + event taxonomy |
| `/supertools-design:seo-framework` | SEO page scaffolding (no content) |
| `/supertools-design:email` | Transactional email setup + templates |
| `/supertools-design:prd` | Final PRD + build-loop-ready task list |

## Provenance

The `.skills/` pipeline was extracted from two production builds that used it
end-to-end, and merged: the fuller tree (including the SEO track and the
build-council engine) plus the later, more-hardened versions of the skills the
two had in common. It has been parameterized so a fresh project supplies its own
identity — but the `*.example.json` configs and `DECISIONS.example.md` still
carry the original product's content as worked examples.

## License

MIT. See [LICENSE](LICENSE).
