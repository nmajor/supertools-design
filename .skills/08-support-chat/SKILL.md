---
name: 08-support-chat
description: Create a Chatwoot account for the project, attach the owner as admin, and provision a Website chat widget + two email inboxes (support@, privacy@) connected to the MXroute mailboxes over IMAP/SMTP, with Lisbon working hours and auto-assignment. Adapted from the tmp support POC.
---

# 08 — Support chat (Chatwoot)

Stand up the project's Chatwoot workspace: a dedicated account, the website
chat widget, and email inboxes that ingest mail sent to `support@` and
`privacy@` (the MXroute mailboxes from skill 07). After this skill, customer
messages — web chat or email — land in one place, auto-assigned to the owner.

Each project gets its own Chatwoot account (the install already hosts
`Proven Hooks`, `NMajor Studios`, etc. — the account is named after the brand).

## Inputs

- `.supertools-state/00/05/07` receipts (status: ok)
- `.supertools-state/project.json` → `domain`, `projectName`
- `CHATWOOT_HOST`, `CHATWOOT_PLATFORM_ACCESS_TOKEN` (create account/attach user),
  `CHATWOOT_ACCESS_TOKEN` (owner user token — creates inboxes)
- `MXROUTE_SERVER`, `MXROUTE_SUPPORT_PASSWORD`, `MXROUTE_PRIVACY_PASSWORD` (IMAP/SMTP)

## What setup.mjs does

1. **Ensure account** named for the brand via the Platform API (reused if
   `CHATWOOT_ACCOUNT_ID` is already persisted).
2. **Attach the owner** (the user behind `CHATWOOT_ACCESS_TOKEN`, i.e.
   `nick@nmajor.com`) as `administrator` on the account.
3. **Website inbox** (`web_widget`): greeting, Lisbon working hours, CSAT,
   auto-assignment, friendly sender name, brand color (rose `#881337`),
   welcome copy. Captures the `website_token` + embed script.
4. **Support email inbox** → IMAP(993)/SMTP(465) to `support@<domain>`.
5. **Privacy email inbox** → IMAP(993)/SMTP(465) to `privacy@<domain>`.
6. **Owner membership + assignment automations**: owner added to each inbox;
   a `conversation_created` automation assigns new conversations to the owner
   (auto-assignment alone proved unreliable when the only agent is offline).
7. **Persist** account/inbox ids + website token to `.env`; save the widget
   embed snippet under `.supertools-state/08-support-chat/`.

## Steps

1. ```sh
   node .skills/08-support-chat/setup.mjs
   ```
2. ```sh
   node .skills/08-support-chat/verify.mjs
   ```
   Confirms the account exists, the owner is an admin member, all three
   inboxes exist with the right channel types, the email inboxes point at the
   MXroute server, and the assignment automations are present.
3. Stage candidate, then **in-line council** + **collab review**
   (`node .skills/_collab-review/run.mjs 08-support-chat`). Both must approve.

## Output

- Chatwoot account named for the brand, with the owner as admin.
- 3 inboxes: Website chat, Support email, Privacy email.
- `.env`: `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_WEBSITE_INBOX_ID`,
  `CHATWOOT_WEBSITE_TOKEN`, `CHATWOOT_SUPPORT_INBOX_ID`, `CHATWOOT_PRIVACY_INBOX_ID`.
- A `widget-embed.html` snippet + a `chat-widget` ralph requirement (the
  Worker embeds the widget site-wide).
- `.supertools-state/08-support-chat.json` — receipt.

## Idempotency

Re-runnable. Account reused via `CHATWOOT_ACCOUNT_ID`; inboxes matched by
name before creating; owner-attach + automations tolerate "already exists".

## Common failure modes

| Symptom | Fix |
|---|---|
| `CHATWOOT_ACCESS_TOKEN is a bot token` | Needs the owner's user Profile API token, not a bot/agent token. |
| Email inbox created but not syncing | IMAP password stale — re-run skill 07 to reset `MXROUTE_*_PASSWORD`, then re-run this skill (it PATCHes the inbox channel). |
| Owner not attached | The platform token can only manage objects it can see; confirm `CHATWOOT_PLATFORM_ACCESS_TOKEN` is a Platform App token. |
