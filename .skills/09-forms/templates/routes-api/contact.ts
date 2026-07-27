// POST /api/contact — general contact form → Chatwoot "Contact form" inbox.
// The /contact page (built by the implementation loop) posts JSON here:
//   { name, email, message, company? }   (company = honeypot)

import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { submitToChatwoot, type FormSubmission } from '../../lib/chatwoot-forms'

export const Route = createFileRoute('/api/contact')({
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
          String(env.CHATWOOT_CONTACT_INBOX_IDENTIFIER || ''),
          body,
          'contact_form',
        )
        return Response.json(result, { status: result.ok ? 200 : 400 })
      },
    },
  },
})
