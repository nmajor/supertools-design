# supertools-design

Opinionated post-[Design OS](https://github.com/buildermethods/design-os) workflows that turn a finished Design OS plan into a full hands-off Ralph-loop deployment package: brand assets, tech-stack picks, working API POCs, analytics taxonomy, SEO scaffolding, transactional email setup, and a final PRD with task list.

## What it adds on top of Design OS

Design OS gets you to: product overview, roadmap, data shape, design system, screen designs, and an export package. It deliberately leaves implementation choices to the agent that picks up the export.

supertools-design picks up where Design OS leaves off and bakes in opinionated defaults so the next step can be a hands-off implementation loop.

| Workflow | Output |
| --- | --- |
| `/supertools-design:logo` | Brand logo, favicon, iOS icons, logo variations |
| `/supertools-design:tech-stack` | Framework, hosting, deployment decisions |
| `/supertools-design:apis` | Third-party API list + working POC scripts |
| `/supertools-design:analytics` | Analytics stack + event taxonomy |
| `/supertools-design:seo-framework` | Resources / SEO page scaffolding (no content) |
| `/supertools-design:email` | Transactional email setup + templates |
| `/supertools-design:prd` | Final PRD + Ralph-loop-ready task list |

Plus three control / orchestration commands:

| Command | Purpose |
| --- | --- |
| `/supertools-design:start` | Initialize the workflow tracker, brief on what's coming |
| `/supertools-design:status` | Show the running tally — what's done, what's next |
| `/supertools-design:bootstrap` | Bootstrap a new project from `product-plan/` and walk a series of "concern" modules to apply defaults |

## Install

Bootstrap a new project:

```sh
curl -fsSL https://raw.githubusercontent.com/nmajor/supertools-design/main/install.sh | bash -s acme
```

That creates `acme-design/` containing a clone of Design OS plus supertools-design wired into `.claude/`. Then:

```sh
cd acme-design
claude
```

supertools-design only runs after Design OS is complete. Finish the Design OS flow first (including its export step that produces `product-plan/`), then in Claude:

```
/supertools-design:start      # initialize and step through workflows
```

The gate is enforced in every supertools-design workflow command — see [docs/architecture.md](docs/architecture.md).

## How it's organized

- `commands/` — One Markdown file per slash command. Auto-namespaced as `/supertools-design:<name>` once symlinked into a project's `.claude/commands/supertools-design/`.
- `concerns/` — Numbered modules used by the `bootstrap` orchestrator. Each is a folder with `SKILL.md` (intent), `verify.mjs` (programmatic smoke test), `requires.json` (deps + env), `README.md`. See [docs/authoring-a-concern.md](docs/authoring-a-concern.md).
- `skills/` — Skills with bundled assets (scripts, templates). Used when a workflow needs more than a single Markdown file.
- `templates/` — Shared snippets that workflows pull from.
- `docs/` — Architecture, workflow-authoring guide, concern-authoring guide.
- `install.sh` — The bootstrap script.
- `.claude-plugin/plugin.json` — Plugin manifest for the optional Claude Code plugin path.

See [docs/architecture.md](docs/architecture.md) for the full design.

## Status

This is v0.1 — a scaffold. The orchestration commands (`start`, `status`, `bootstrap`) are real; every workflow command and every concern is a placeholder stub. Workflows and concerns get filled in one at a time.

## License

MIT. See [LICENSE](LICENSE).
