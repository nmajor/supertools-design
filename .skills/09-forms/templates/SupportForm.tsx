// Minimal, on-brand support/contact form. Posts JSON to a server route
// ({ name, email, message, company? }) and shows success / error states.
// The implementation loop may restyle this; the wiring is what matters.

import { useState } from 'react'

export interface SupportFormProps {
  endpoint: string // e.g. "/api/contact" or "/api/privacy"
  heading: string
  intro: string
  submitLabel?: string
}

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
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
        <p className="font-medium">Thanks — your message is on its way.</p>
        <p className="mt-1 text-sm">We&rsquo;ll reply by email as soon as we can.</p>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <h1 className="text-2xl italic text-rose-900 dark:text-rose-300" style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 600 }}>{heading}</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">{intro}</p>
      </div>
      <label className="block">
        <span className="text-sm text-stone-700 dark:text-stone-300">Name</span>
        <input name="name" type="text" autoComplete="name"
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-50" />
      </label>
      <label className="block">
        <span className="text-sm text-stone-700 dark:text-stone-300">Email <span className="text-rose-700">*</span></span>
        <input name="email" type="email" required autoComplete="email"
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-50" />
      </label>
      <label className="block">
        <span className="text-sm text-stone-700 dark:text-stone-300">Message <span className="text-rose-700">*</span></span>
        <textarea name="message" required rows={5}
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-50" />
      </label>
      {/* honeypot — visually hidden; bots fill it, humans don't */}
      <div aria-hidden className="absolute left-[-9999px]" style={{ position: 'absolute', left: '-9999px' }}>
        <label>Company<input name="company" type="text" tabIndex={-1} autoComplete="off" /></label>
      </div>
      {status === 'error' && <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>}
      <button type="submit" disabled={status === 'sending'}
        className="rounded-full bg-rose-900 px-5 py-2.5 text-stone-50 transition-all hover:-translate-y-0.5 hover:bg-rose-950 disabled:opacity-60 dark:bg-rose-300 dark:text-rose-950 dark:hover:bg-rose-200">
        {status === 'sending' ? 'Sending…' : submitLabel}
      </button>
    </form>
  )
}
