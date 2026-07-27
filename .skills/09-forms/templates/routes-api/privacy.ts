// POST /api/privacy — privacy/data-rights request form → Chatwoot
// "Privacy form" inbox. The /privacy page posts JSON here:
//   { name, email, message, company? }   (company = honeypot)

import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { submitToChatwoot, type FormSubmission } from '../../lib/chatwoot-forms'

export const Route = createFileRoute('/api/privacy')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: FormSubmission
        try {
          body = (await request.json()) as FormSubmission
        } catch {
          return Response.json({ ok: false, error: 'Invalid request body.' }, { status: 400 })
        }
        const result = await submitToChatwoot(
          String(env.CHATWOOT_PRIVACY_INBOX_IDENTIFIER || ''),
          body,
          'privacy_form',
        )
        return Response.json(result, { status: result.ok ? 200 : 400 })
      },
    },
  },
})
