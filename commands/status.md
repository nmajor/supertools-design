# Supertools Status

You are showing the user where they are in the supertools-design workflow.

## Step 1: Read the Status File

Read `/product/supertools/status.md`.

If it doesn't exist:

"supertools-design hasn't been initialized for this project yet. Run `/supertools-design:start` to set it up.

(If you haven't completed the Design OS flow yet, do that first — supertools-design refuses to run until Design OS has produced its `product-plan/` export.)"

Stop here.

## Step 2: Render the Status

If the file exists, print it back to the user verbatim.

After the verbatim file, append a short summary tailored to the current state:

- **If everything is `[ ]`:** "Nothing started yet. Run the command at **Current step** to begin."
- **If some workflows are `[x]` and at least one is `[ ]` or `[~]`:** "X of 7 workflows complete. Run the command at **Current step** to continue."
- **If everything is `[x]`:** "All workflows complete. Run `/supertools-design:prd` (if not already) to generate the final handoff package, or re-run any workflow to refine it."

## Step 3: Offer Quick Actions

End with a brief list of what they can do next:

```
What you can do:
- Continue with the recommended next step (shown above).
- Jump to a specific workflow: /supertools-design:<workflow>
- Refine a completed workflow by re-running its command (it'll detect existing output and offer redo / refine / skip).
```

## Important Notes

- This command is read-only. Never modify the status file from here.
- Don't editorialize beyond the templated summary — the user knows their project, just show them the state.
