# Supertools Start

You are initializing the supertools-design workflow for the user. This command sets up the status tracker and explains what supertools-design adds on top of Design OS.

## Step 1: Check Design OS is complete

supertools-design refuses to run any workflow until Design OS is fully complete. Verify both files exist:

1. `product-plan/README.md`
2. `product-plan/product-overview.md`

If either is missing, tell the user:

"supertools-design only runs after Design OS is complete. I don't see a finished `product-plan/` directory — that's what Design OS produces when its export step finishes.

Please complete the Design OS flow (including its export step) so that `product-plan/` exists with `README.md` and `product-overview.md`, then return."

Stop. Do not proceed.

## Step 2: Check If Already Initialized

Read `/product/supertools/status.md`.

If it exists, skip to Step 4 and just print the current status. Mention that the user can run any individual workflow command directly, or `/supertools-design:status` to see progress.

If it doesn't exist, continue to Step 3.

## Step 3: Brief and Initialize

Tell the user (adapting tone to be warm and instructional):

"Welcome to supertools-design.

You've defined **[Product Name]** with Design OS. supertools-design picks up from there and bakes in the implementation details Design OS leaves open — brand assets, tech-stack picks, working API integrations, analytics, SEO scaffolding, email setup, and a final PRD that a hands-off implementation loop can run end-to-end.

There are seven workflows. They run in this recommended order, but you can jump around — each one is self-contained:

1. **logo** — Brand logo, favicon, iOS icons, logo variations
2. **tech-stack** — Framework, hosting, deployment decisions
3. **apis** — Third-party APIs you'll integrate, with working POC scripts
4. **analytics** — Analytics stack and event taxonomy
5. **seo-framework** — Resources / SEO page scaffolding (no content yet — just the framework)
6. **email** — Transactional email setup and templates
7. **prd** — Final PRD + Ralph-loop-ready task list

I've created a status tracker at `product/supertools/status.md` that shows what's done and what's next. Run `/supertools-design:status` any time to see it.

Ready to begin? Run `/supertools-design:logo` to start with the brand."

Then create the directory and the initial status file.

### Create directory

Ensure `product/supertools/` exists. Create it if not.

### Create the status file

Write `product/supertools/status.md` with this exact format. Replace `[YYYY-MM-DD]` with today's date and `[Product Name]` with the product name from `/product/product-overview.md`:

```markdown
# Supertools Design Status — [Product Name]

_Last updated: [YYYY-MM-DD] — initialized_

## Workflows

- [ ] **logo** — Brand logo, favicon, iOS icons, logo variations
- [ ] **tech-stack** — Framework, hosting, deployment decisions
- [ ] **apis** — Third-party APIs and working POC scripts
- [ ] **analytics** — Analytics stack and event taxonomy
- [ ] **seo-framework** — Resources / SEO page scaffolding
- [ ] **email** — Transactional email setup and templates
- [ ] **prd** — Final PRD and Ralph-loop-ready task list

## Current step

Run `/supertools-design:logo` to start.

## Notes

- [YYYY-MM-DD] Initialized supertools-design tracker.
```

State legend (used throughout the file as workflows progress):

- `[ ]` not started
- `[~]` in progress / partial output
- `[x]` complete

## Step 4: Confirm

If the file was just created:

"I've initialized the supertools-design tracker at `product/supertools/status.md`.

Recommended next step: run `/supertools-design:logo` to generate the brand assets.

You can also jump to any workflow directly, or run `/supertools-design:status` any time to see progress."

If the file already existed (from Step 2), instead just print the current status by reading and rendering `/product/supertools/status.md`, and tell the user to continue from the **Current step** line.

## Important Notes

- This command is idempotent. Running it twice doesn't reset progress — it just re-prints the briefing.
- The status file is the single source of truth for "what's been done." Every workflow command reads it before doing anything and updates it before exiting.
- This command writes only to `product/supertools/`. It must not touch `product-plan/`.
