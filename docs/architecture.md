# Architecture

## Goals

1. Pick up from a finished Design OS plan and produce everything an implementation loop (e.g. Ralph) needs to build the app hands-off.
2. Keep workflows highly opinionated — minimize user input, encode defaults.
3. Make progress legible: a single status file the user (and Claude) can inspect at any time to see what's done and what's next.
4. Stay composable: each workflow stands alone, can be redone, and writes to its own subdirectory.

## Hard prerequisite: Design OS must be complete

Every supertools-design command — including `start`, every workflow command, and every future workflow we add — refuses to do any work unless Design OS is fully complete and has produced its export package.

The check is simple and identical in every command:

1. `product-plan/README.md` exists.
2. `product-plan/product-overview.md` exists.

If either is missing, the command tells the user to finish Design OS (including its export step) and stops. No partial runs, no "Design OS-lite" mode.

We check the *output* of Design OS, not the steps that produced it. supertools-design must not hardcode Design OS command names — those belong to Design OS and may change. Our contract is the existence of `product-plan/` with the canonical files.

`/supertools-design:status` is the one exception — it's read-only and useful even before Design OS is done (it prompts the user to run `/supertools-design:start` if the tracker doesn't exist yet).

## Mental model

Design OS produces the product definition (`product/`) and screen designs (`src/`). supertools-design produces the *implementation surround* — everything that has to be decided before code can be written, that Design OS deliberately leaves open.

The boundary is clean: Design OS owns `product/` and `src/`, supertools-design owns `product/supertools/`.

## Directory contract

In a bootstrapped project:

```
<project>-design/
├── product/                       # Design OS owns this
│   ├── product-overview.md
│   ├── product-roadmap.md
│   ├── data-shape/
│   ├── design-system/
│   ├── shell/
│   ├── sections/
│   └── supertools/                # supertools-design owns this subtree
│       ├── status.md              # the running tally
│       ├── logo/                  # one subdir per workflow output
│       ├── tech-stack/
│       ├── apis/
│       ├── analytics/
│       ├── seo-framework/
│       ├── email/
│       └── prd/
├── src/                           # Design OS owns
├── product-plan/                  # Design OS export package + supertools handoff
├── .claude/                       # Wired by install.sh
│   ├── commands/
│   │   ├── design-os/             # from upstream Design OS
│   │   └── supertools-design/  →  ../../.supertools/commands
│   └── skills/
│       └── supertools-design/  →  ../../.supertools/skills
└── .supertools/                   # vendored copy of this repo
```

## State tracking

A single Markdown file at `product/supertools/status.md` is the source of truth for "what's been done." It contains:

- A checklist of every workflow with its current state (`[ ]`, `[~]` in progress, `[x]` complete) and a one-line description.
- A "Current step" pointer — the recommended next command to run.
- A free-form Notes section where workflows append decisions, deferrals, and blockers as they go.
- A timestamp.

The format is human-readable and the file is checked into git. `/supertools-design:status` renders it back. `/supertools-design:start` creates it. Each workflow command updates the line for its own workflow and the timestamp.

This is deliberately the same implicit-state pattern Design OS uses (files-on-disk drive prerequisite checks), with one extra: an explicit checklist file for the user's "where am I" question.

## The shape of a workflow command

Every `commands/<workflow>.md` follows the same skeleton, modeled on Design OS:

```
# <Workflow Title>

You are helping the user <one-line purpose>.

## Step 1: Check Prerequisites
  - Verify Design OS outputs needed for this workflow exist (read product-overview.md, etc.)
  - Verify any supertools-design dependencies (e.g. logo runs first, prd runs last)
  - If something's missing, name the exact command to run and STOP.

## Step 2: Check Current State
  - Read product/supertools/status.md to see if this workflow has run before.
  - If complete, ask: redo from scratch, refine specific output, or skip?
  - If in-progress (e.g. partial outputs), summarize what's there and offer to continue.

## Step 3: Gather Just-Enough Input
  - Use AskUserQuestion sparingly. Most decisions should have an opinionated default.
  - Only ask when the answer materially changes the output AND can't be inferred.

## Step 4: Generate Outputs
  - Write to product/supertools/<workflow>/.
  - Outputs are a mix of decision documents (Markdown), config snippets, working code,
    and assets. Each workflow defines its own output contract.

## Step 5: Update Status
  - Mark this workflow's checkbox in product/supertools/status.md.
  - Update the timestamp.
  - Append a brief note (1–2 lines) summarizing key decisions.
  - Update the "Current step" pointer to the next recommended workflow.

## Step 6: Hand Off
  - Print a short summary of what was created.
  - Tell the user what command to run next.
```

See [authoring-a-workflow.md](authoring-a-workflow.md) for the full template and a checklist when adding a new workflow.

## Bootstrapping new projects (concerns + receipts)

Distinct from the per-workflow commands above, supertools-design also exposes a bootstrap orchestrator (`/supertools-design:bootstrap`) that creates a new project folder from a finished Design OS plan and applies defaults via a series of **concern** modules.

The bootstrap pattern is independent of the workflow pattern. Workflows produce decision documents that go in `product/supertools/<workflow>/` and update `status.md`; concerns wire up real infrastructure in a new project folder and track progress via per-concern receipts.

### Concerns

A concern is a self-contained module of the bootstrap pipeline. Each lives in `concerns/<NN-name>/` with four files:

- `SKILL.md` — intent prose (run by Claude when the orchestrator invokes the concern)
- `verify.mjs` — programmatic smoke test (exit 0/1)
- `requires.json` — declared dependencies and env requirements
- `README.md` — human-readable purpose

The numeric prefix determines run order. The orchestrator walks them in order. Adding a new concern = creating a new numbered folder; the orchestrator picks it up automatically.

### Receipts

Each concern writes a receipt to `<project>/.supertools-state/<concern-name>.json` on success. The orchestrator skips concerns with valid receipts on re-runs, making the pipeline resumable after partial failures.

The orchestrator's own state lives at `product/supertools/bootstrap-state.json` in the design folder — it tracks the project path and domain so re-runs of `/supertools-design:bootstrap` can pick up where they left off.

### Why concerns instead of more workflows

The workflow pattern (single Markdown command, `product/supertools/status.md` tracker) is the right shape for **decision-document workflows** that produce specs the user reviews. It's not the right shape for a long pipeline that has to wire things up against external services (Cloudflare, GitHub, etc.) and may fail in the middle.

Concerns add three things workflows don't:
- **Bundled non-Markdown assets** (verify scripts) for programmatic verification — never ask Claude to verify, run a probe.
- **Receipts** for resumability across runs.
- **Numeric ordering** for an explicit pipeline contract.

When designing new functionality: use a workflow for "produce a decision document"; use a concern for "actually set something up." See [authoring-a-concern.md](authoring-a-concern.md).

## Why commands, not skills (for now)

Claude Code skills (`skills/<name>/SKILL.md`) support bundled scripts and richer frontmatter, while commands (`commands/<name>.md`) are flat Markdown. Most workflows are conversational and write text outputs — a single `.md` file is sufficient.

Workflows that need bundled helpers (scripts, templates) get promoted to a skill under `skills/` when the time comes. The status-tracker pattern is identical either way.

## Why a vendored clone, not a submodule

A vendored copy at `.supertools/` (without its own `.git`) gets committed as part of the project. This means:
- Fresh checkouts on any machine work without re-running `install.sh`.
- The project is self-contained — useful when the project is itself a Design OS planning checkout that gets thrown away after export.
- Updating supertools-design is a deliberate action: re-clone over `.supertools/` (the install script's last log line shows the one-liner).

Trade-off: there's no automatic upgrade path. That's intentional — workflows are opinionated and updates can change defaults; we want the user to pull updates explicitly.
