# Integration rubric (apply alongside the correctness rubric above)

The single biggest failure mode of an incremental build loop is a task that is
correct **in isolation** but **not connected** to the rest of the app. Verify the
diff is actually wired in, end to end:

- **Routing** — new routes/pages are registered in the route tree and reachable
  (not orphaned files). Navigation to/from them exists where the design requires.
- **Frontend ↔ backend** — UI callbacks call **real** endpoints that exist in
  this repo; request/response shapes match; the endpoint persists to / reads from
  the real bindings (D1/R2/KV/Queue), not a placeholder.
- **Data flow** — the data this task produces is consumed by whatever needs it
  downstream (e.g. quiz → directions → order → pack → boards), and the data it
  consumes is actually produced upstream. No dangling reads/writes.
- **Cross-cutting wiring** — analytics events fire where the taxonomy expects;
  emails use the correct transactional envelope; auth/session gates are applied
  to protected surfaces; the Chatwoot widget / legal links remain present.
- **Contracts** — shared types match across the boundary; no `any`-smuggled
  mismatches between producer and consumer.

If the task is correct but not integrated, **CODE_REJECTED** with the specific
missing wire-up (file:line + what to connect to what).
