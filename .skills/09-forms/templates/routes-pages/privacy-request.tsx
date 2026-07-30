import { createFileRoute } from '@tanstack/react-router'
// The `@/` alias (tsconfig paths -> ./src/*) rather than a relative path:
// these pages live under the marketing layout, and a `../` count that is
// correct at one depth silently breaks when the file moves.
import { SupportForm } from '@/components/SupportForm'

export const Route = createFileRoute('/_marketing/privacy-request')({
  head: () => ({ meta: [{ title: 'Privacy Request · __BRAND_NAME__' }] }),
  component: PrivacyRequestPage,
})

function PrivacyRequestPage() {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-12 sm:px-6">
      <SupportForm
        endpoint="/api/privacy"
        heading="Privacy request"
        intro="Ask us to access, correct, or delete your data, or any other privacy question. We'll respond to the email you provide."
        submitLabel="Submit request"
      />
    </main>
  )
}
