import { createFileRoute } from '@tanstack/react-router'
import { SupportForm } from '../components/SupportForm'

export const Route = createFileRoute('/privacy-request')({
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
