// Server-side helper: push a website form submission into a Chatwoot
// API-channel inbox via the public API (contact → conversation → message).
// No auth token needed — the inbox_identifier authorizes the public endpoints.
//
// Used by the /api/contact and /api/privacy server routes (skill 09-forms).

import { env } from 'cloudflare:workers'

export interface FormSubmission {
  name: string
  email: string
  message: string
  /** Spam honeypot — must be empty. */
  company?: string
}

export interface SubmitResult {
  ok: boolean
  conversationId?: number
  error?: string
}

const base = () => String(env.CHATWOOT_HOST || '').replace(/\/+$/, '')

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Validate + submit a form into the given Chatwoot API inbox.
 * `source` labels the origin (e.g. "contact_form", "privacy_form").
 */
export async function submitToChatwoot(
  inboxIdentifier: string,
  submission: FormSubmission,
  source: string,
): Promise<SubmitResult> {
  // Guard non-object bodies (null, arrays, primitives) before field access.
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
    return { ok: false, error: 'A valid submission is required.' }
  }
  // Honeypot: silently accept bots without creating a conversation.
  if (submission.company && submission.company.trim() !== '') {
    return { ok: true }
  }

  const name = (submission.name || '').trim()
  const email = (submission.email || '').trim()
  const message = (submission.message || '').trim()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'A valid email is required.' }
  if (!message) return { ok: false, error: 'A message is required.' }

  if (!base() || !inboxIdentifier) return { ok: false, error: 'Form intake is not configured.' }

  const root = `${base()}/public/api/v1/inboxes/${inboxIdentifier}`

  const contactRes = await postJson(`${root}/contacts`, {
    identifier: email,
    email,
    name: name || email,
    custom_attributes: { source },
  })
  if (!contactRes.ok) return { ok: false, error: 'Could not reach support intake.' }
  const contact = (await contactRes.json()) as { source_id?: string }
  if (!contact.source_id) return { ok: false, error: 'Could not create contact.' }

  const convRes = await postJson(`${root}/contacts/${contact.source_id}/conversations`, {
    custom_attributes: { source },
  })
  if (!convRes.ok) return { ok: false, error: 'Could not open a conversation.' }
  const conversation = (await convRes.json()) as { id?: number }
  if (!conversation.id) return { ok: false, error: 'Could not open a conversation.' }

  const body = `Name: ${name || '(not given)'}\nEmail: ${email}\n\n${message}`
  const msgRes = await postJson(
    `${root}/contacts/${contact.source_id}/conversations/${conversation.id}/messages`,
    { content: body },
  )
  if (!msgRes.ok) return { ok: false, error: 'Could not deliver your message.' }

  return { ok: true, conversationId: conversation.id }
}
