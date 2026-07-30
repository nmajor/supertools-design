// Minimal support/contact form. Posts JSON to a server route
// ({ name, email, message, company? }) and shows success / error states.
//
// STYLING RULE (authoring-checklist rule 23): this template must not carry a
// brand. Accent colour comes from `--color-primary`, which skill 02 writes into
// src/styles.css from the Design OS export, referenced here as an arbitrary
// Tailwind value. Neutrals use `zinc`, the stock Tailwind neutral, so a project
// that says nothing about neutrals still gets something coherent.
//
// A previous version hardcoded `rose-*` (primary), `stone-*` (neutral),
// `emerald-*` (success) and an inline `"Fraunces", Georgia, serif` — the
// reference implementation's brand. Every project's contact form rendered in
// that brand under its own name.
//
// Headings use the `font-serif` utility because skill 02 binds `--font-serif`
// to the export's HEADING face by ROLE, whether or not that face is a serif.

import { useState } from 'react'

export interface SupportFormProps {
  endpoint: string // e.g. "/api/contact" or "/api/privacy"
  heading: string
  intro: string
  submitLabel?: string
}

const FIELD =
  'mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 ' +
  'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-1 ' +
  'dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50'

const LABEL = 'text-sm text-zinc-700 dark:text-zinc-300'

export function SupportForm({ endpoint, heading, intro, submitLabel = 'Send' }: SupportFormProps) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState('')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus('sending')
    setError('')
    const form = e.currentTarget
    const data = new FormData(form)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: String(data.get('name') || ''),
          email: String(data.get('email') || ''),
          message: String(data.get('message') || ''),
          company: String(data.get('company') || ''), // honeypot
        }),
      })
      const json = (await res.json()) as { ok: boolean; error?: string }
      if (json.ok) { setStatus('sent'); form.reset() }
      else { setStatus('error'); setError(json.error || 'Something went wrong.') }
    } catch {
      setStatus('error')
      setError('Network error — please try again.')
    }
  }

  if (status === 'sent') {
    return (
      <div
        role="status"
        className="rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 p-6 text-zinc-900 dark:text-zinc-100"
      >
        <p className="font-medium">Thanks — your message is on its way.</p>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          We&rsquo;ll reply by email as soon as we can.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {heading}
        </h1>
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">{intro}</p>
      </div>

      <label className="block">
        <span className={LABEL}>Name</span>
        <input name="name" type="text" autoComplete="name" className={FIELD} />
      </label>

      <label className="block">
        <span className={LABEL}>
          Email <span className="text-[var(--color-primary)]" aria-hidden>*</span>
          <span className="sr-only">(required)</span>
        </span>
        <input name="email" type="email" required autoComplete="email" className={FIELD} />
      </label>

      <label className="block">
        <span className={LABEL}>
          Message <span className="text-[var(--color-primary)]" aria-hidden>*</span>
          <span className="sr-only">(required)</span>
        </span>
        <textarea name="message" required rows={5} className={FIELD} />
      </label>

      {/* honeypot — visually hidden; bots fill it, humans don't */}
      <div aria-hidden className="absolute left-[-9999px]" style={{ position: 'absolute', left: '-9999px' }}>
        <label>Company<input name="company" type="text" tabIndex={-1} autoComplete="off" /></label>
      </div>

      {/* Problems are amber, not red. Red is reserved for states that must be
          unmistakable at a glance; spending it on a form error weakens it. */}
      {status === 'error' && (
        <p role="alert" className="text-sm font-medium text-amber-700 dark:text-amber-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={status === 'sending'}
        className="rounded-lg bg-[var(--color-primary)] px-5 py-2.5 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2"
      >
        {status === 'sending' ? 'Sending…' : submitLabel}
      </button>
    </form>
  )
}
