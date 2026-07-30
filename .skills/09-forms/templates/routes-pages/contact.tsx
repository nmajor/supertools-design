import { createFileRoute } from '@tanstack/react-router'
// The `@/` alias (tsconfig paths -> ./src/*) rather than a relative path:
// these pages live under the marketing layout, and a `../` count that is
// correct at one depth silently breaks when the file moves.
import { SupportForm } from '@/components/SupportForm'

export const Route = createFileRoute('/_marketing/contact')({
  head: () => ({ meta: [{ title: 'Contact · __BRAND_NAME__' }] }),
  component: ContactPage,
})

function ContactPage() {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-12 sm:px-6">
      <SupportForm
        endpoint="/api/contact"
        heading="Get in touch"
        intro="Questions, feedback, or trouble with your pack? Send us a note and we'll reply by email."
        submitLabel="Send message"
      />
    </main>
  )
}
