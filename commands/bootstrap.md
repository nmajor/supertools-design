# Bootstrap

You are running the supertools-design `bootstrap` orchestrator. Bootstrap walks the user through bootstrapping a new project from their finished Design OS plan, applying defaults via a series of "concern" modules located in `.supertools/concerns/`.

## Step 1: Check Design OS is complete

supertools-design refuses to run any workflow until Design OS is fully complete. Verify both files exist:

1. `product-plan/README.md`
2. `product-plan/product-overview.md`

If either is missing, tell the user Design OS isn't complete and they need to finish it (including its export step) so that `product-plan/` exists with the canonical files. Stop.

## Step 2: Resume or start fresh

Check whether `product/supertools/bootstrap-state.json` already exists in the current folder.

- **If it exists:** read it. It contains `{ "projectPath", "domain", "started", "lastRun" }`. Tell the user "Resuming bootstrap for [domain] at [projectPath]." Update `lastRun` to now. Skip to Step 6.
- **If it does not exist:** continue to Step 3 (fresh run).

## Step 3: Ask where to bootstrap, and confirm the domain

Ask the user two things together (use AskUserQuestion when available):

1. **Project folder path.** The default suggestion is a sibling folder to the current one, with `-design` stripped from the name. For example, if the current folder is `/home/user/projects/acme-design`, the default is `/home/user/projects/acme`. Ask: "Where should I bootstrap the project? I suggest [default]. Confirm or override."
2. **Domain name.** Ask: "What's the domain name for this project? Has it been purchased on Cloudflare?" Do not proceed until they confirm both the name and that it's purchased.

Wait for both answers. Do not assume or invent a domain.

## Step 4: Create the project folder and copy product-plan

- If the chosen project folder already exists and is non-empty, halt and ask the user how to proceed (use the existing folder, pick a different one, or abort). Do not overwrite without confirmation.
- Otherwise, create the folder.
- Recursively copy `product-plan/` from the current folder into `<project>/product-plan/`.
- Create `<project>/.supertools-state/`.

## Step 5: Persist orchestrator state

Write `product/supertools/bootstrap-state.json` in the current (`-design`) folder with:

```json
{
  "projectPath": "<absolute path to project>",
  "domain": "<domain>",
  "started": "<ISO8601 now>",
  "lastRun": "<ISO8601 now>"
}
```

Also write `<project>/.supertools-state/project.json` with the same fields plus a `sourceDesignFolder` pointing back at the current folder.

## Step 6: Walk concerns in order

List the directories under `.supertools/concerns/` and sort by their numeric prefix (e.g. `00-prereqs`, `10-project-init`, `20-database`, ..., `99-deploy`).

For each concern in order:

1. **Check for an existing receipt** at `<project>/.supertools-state/<concern-name>.json`. If it exists and `status` is `"ok"`, print `skipped: <concern-name> (receipt found)` and continue to the next concern.
2. **Read the concern's intent** from `.supertools/concerns/<concern-name>/SKILL.md` and follow its instructions exactly.
3. **Run the concern's verifier** by invoking `node .supertools/concerns/<concern-name>/verify.mjs` from the project folder (`<project>`). Pass the project path as the first argument if the verifier needs it.
4. **If verify exits 0**, write the receipt at `<project>/.supertools-state/<concern-name>.json` with the receipt schema (see Step 7).
5. **If verify exits non-zero**, halt the entire bootstrap. Tell the user which concern failed, what the verifier reported, and that they can re-run `/supertools-design:bootstrap` after fixing the issue (already-completed concerns will be skipped via their receipts).

Do not skip ahead. Do not run concerns out of order.

## Step 7: Receipt schema

Every concern receipt must have at minimum:

```json
{
  "status": "ok" | "stub" | "skipped",
  "version": "<concern's own version string>",
  "timestamp": "<ISO8601>",
  "summary": "<one-line summary of what was done>"
}
```

A concern's `SKILL.md` may add concern-specific fields (e.g. `databaseId`, `zoneId`, `repoUrl`). Do not invent fields not declared by the concern.

For v0.1 stubs, the receipt status will be `"stub"` and the summary will be `"stub: not implemented in v0.1"`.

## Step 8: Confirm completion

When all concerns have receipts, tell the user:

"Bootstrap complete for **[domain]** at **[projectPath]**.

Concerns run:
- 00-prereqs ✓
- 10-project-init ✓
- ... (list each)

In v0.1, all concerns are stubs — no real bootstrapping happened. Real implementations will be filled in concern by concern."

## Important Notes

- **Idempotent.** Running `/supertools-design:bootstrap` again resumes from the orchestrator state file and skips concerns with valid receipts.
- **Do not modify the symbolic order** (numeric prefixes) of concerns mid-run.
- **Do not invent commands or flags** for tools (Wrangler, gh, etc.). Each concern's SKILL.md is authoritative for what gets run; if a concern is a stub, do not improvise actual setup.
- **Do not write outside `<project>/` and `product/supertools/bootstrap-state.json`** in the design folder.
- **Do not edit `product/supertools/status.md`** from this command. Bootstrap progress lives in the project's `.supertools-state/` receipts, not in the design-folder status tracker.
