import { createFileRoute } from '@tanstack/react-router'
import { SupportForm } from '../components/SupportForm'

export const Route = createFileRoute('/contact')({
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
