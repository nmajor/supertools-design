// Analytics event taxonomy + a typed track() wrapper over Rybbit.
//
// The Rybbit tracking script (injected in __root.tsx) exposes a global
// `window.rybbit` with `event(name, properties)` and `pageview()`. This
// module gives the app a single, typed surface for custom events so event
// names don't drift across the funnel. Pageviews are automatic via the script.
//
// Derived from the product funnel: Landing → Style Quiz → Style Directions →
// Your Pack → My Boards.

declare global {
  interface Window {
    rybbit?: {
      event: (name: string, properties?: Record<string, unknown>) => void
      pageview?: () => void
    }
  }
}

/** Canonical event names. Keep this the single source of truth. */
export const AnalyticsEvent = {
  // Landing → funnel entry
  CREATE_BOARD_CLICKED: 'create_board_clicked',
  EXAMPLE_BOARD_OPENED: 'example_board_opened',

  // Style Quiz
  QUIZ_STARTED: 'quiz_started',
  QUIZ_STEP_COMPLETED: 'quiz_step_completed',
  QUIZ_GENERATING_VIEWED: 'quiz_generating_viewed',
  QUIZ_COMPLETED: 'quiz_completed',

  // Style Directions (paywall)
  DIRECTIONS_VIEWED: 'directions_viewed',
  PREMIUM_SHEET_OPENED: 'premium_sheet_opened',
  CHECKOUT_STARTED: 'checkout_started',
  PURCHASE_COMPLETED: 'purchase_completed',

  // Your Pack
  PACK_RENDER_STARTED: 'pack_render_started',
  PACK_RENDERED: 'pack_rendered',
  PACK_CARD_DOWNLOADED: 'pack_card_downloaded',
  PACK_CARD_PINNED: 'pack_card_pinned',
  PACK_REFINEMENT_REQUESTED: 'pack_refinement_requested',
  SHARE_LINK_COPIED: 'share_link_copied',

  // My Boards
  BOARDS_VIEWED: 'boards_viewed',
  NEW_PACK_STARTED: 'new_pack_started',

  // Support / legal forms
  CONTACT_SUBMITTED: 'contact_submitted',
  PRIVACY_SUBMITTED: 'privacy_submitted',
} as const

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent]

/** Fire a custom analytics event. No-op on the server / before the script loads. */
export function track(name: AnalyticsEventName, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  try {
    window.rybbit?.event(name, properties)
  } catch {
    // Analytics must never break the app.
  }
}
