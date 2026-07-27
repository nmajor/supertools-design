// GET /api/health — lightweight liveness endpoint. Returns 200 + a small
// JSON body. Used by the post-deploy smoke check (skill 16) and any external
// monitor. The scheduled cron heartbeat (pinging Healthchecks) is separate —
// see the ralph requirement from skill 13-uptime.
// (No leading underscore in the route segment — in TanStack file routing a
// leading "_" denotes a pathless layout, not a literal path segment.)

import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => Response.json({ ok: true, service: '__PROJECT_NAME__', ts: new Date().toISOString() }),
    },
  },
})
