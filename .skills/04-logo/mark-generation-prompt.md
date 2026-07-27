# Logo-mark generation prompt template

This file is the prompt fed to `claude -p` when skill 04 needs to generate a
logo mark for a project that has no `design/brand/logo-mark.svg` override.

The skill reads this file, substitutes the `{{PLACEHOLDERS}}`, and sends the
result as the prompt. Reply must be raw SVG with no markdown fences.

## Why this works (notes for humans iterating on the prompt)

- **Constrained shape vocabulary** — LLMs reliably emit valid SVG when limited
  to rect/circle/ellipse/line/path. Complex path commands (cubic curves,
  arcs) cause more invalid output.
- **No letterforms** — LLMs are bad at font metrics. Text-in-svg almost
  always renders smaller/different than expected. Force shapes-only.
- **Small viewBox (96)** — keeps coordinate arithmetic in single-/double-digit
  range; LLMs make fewer math errors there.
- **Brand-color constraint** — supply 4-5 exact hex values so the LLM can't
  invent colors that clash with the rest of the brand system.
- **Anti-cliché list** — explicitly enumerate the bad archetypes (single
  letter in rounded square, generic abstract Slack-petals, smiley face) so
  the model doesn't default to them.
- **Reference real product marks** — Figma/Linear/Notion/Vercel give the LLM
  concrete style anchors rather than vague "minimal" or "geometric."
- **Concept hint from product overview** — gives the mark something to *be
  about*, not just look pretty.

---

```prompt-template
You are designing a minimal SVG brand mark for a software product.

PRODUCT NAME: {{PRODUCT_NAME}}

PRODUCT DESCRIPTION (3-5 sentences from the product overview):
{{PRODUCT_OVERVIEW}}

BRAND PALETTE:
- primary family: {{PRIMARY_FAMILY}}
- secondary family: {{SECONDARY_FAMILY}}
- neutral family: {{NEUTRAL_FAMILY}}

KEY HEX COLORS YOU MAY USE (do not invent others):
{{HEX_PALETTE_LIST}}

CONSTRAINTS:
- Output must be a valid SVG with `viewBox="0 0 96 96"`.
- Use ONLY these elements: <rect>, <circle>, <ellipse>, <line>, <path>
  (with M/L/Q/C/Z commands only — no A arc commands).
- ABSOLUTELY NO <text>, <tspan>, <foreignObject>, no letterforms of any
  kind. The mark must communicate via shapes.
- Use AT MOST 4 distinct colors, all drawn from the KEY HEX COLORS list.
- Start with a rounded-rectangle background using rx="18" in the lightest
  neutral shade.
- The composition must suggest the product's core concept visually
  (metaphorically OK — don't try to be literal).

ANTI-CLICHÉS (do NOT use any of these):
- A single capital letter inside a rounded square (Vanguard, Venmo,
  Notion-clone trap)
- A generic 4-circle "petal" arrangement (Slack-clone)
- A smiley or face shape
- A generic chevron or "play button" triangle
- Random unrelated geometric shapes that don't connect to the product

STYLE REFERENCES (pick the closest match for inspiration):
- Figma's mark: stacked offset shapes representing layers/state
- Linear's mark: clean geometric primitive with strong negative space
- Vercel's mark: a single bold filled primitive
- Stripe's mark: a stylized cut/slash suggesting flow

OUTPUT FORMAT:
Reply with ONLY the raw SVG XML — no markdown code fences, no commentary,
no preamble. Your reply must start with:
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
and end with:
  </svg>
```
