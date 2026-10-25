---
version: alpha
name: Front Porch
description: A warm, large-and-calm system for older professionals and the family helping them. Warm paper canvas, an editorial serif for feeling and a hyperlegible sans for facts, blush and sage bands that pace the page, and one rose accent for every action. Craft borrowed from Oura (paper canvas, type rhythm, soft elevation, pill/card radius split); palette, accessibility and illustrations are our own.

colors:
  rose: "#A8475E"        # the only accent: buttons, links, selected states
  rose-dark: "#8E3A4F"   # rose hover
  on-rose: "#FFFFFF"
  ink: "#3A2A2E"         # all text; dark footer band; pressed button
  paper: "#FBF7F3"       # page canvas (warm paper, from Oura's cream)
  surface: "#FFFFFF"     # cards, inputs on focus, choice cards
  blush: "#FCEEF1"       # hero / band fill, selected fill, tags
  pink: "#F2B8C6"        # rules, number badges, illustration
  pink-tint: "#F7D6DE"   # pressed secondary
  sage: "#8FAE9B"        # illustration, list dots, balance
  sage-tint: "#E6EEE9"   # band fill, calm notes and summaries
  line: "#EBD3DA"        # 1px hairline on paper and white
  muted: "#6B5359"       # secondary text, pill borders
  field: "#8C6F77"       # input borders, placeholders
  alert: "#A3242F"
  alert-tint: "#FBE4E8"

typography:
  display:   { fontFamily: Literata, fontSize: "clamp(44px..72px)", fontWeight: 400, lineHeight: 1.05, letterSpacing: -0.02em }
  heading:   { fontFamily: Literata, fontSize: "clamp(36px..52px)", fontWeight: 400, lineHeight: 1.1, letterSpacing: -0.015em }
  title:     { fontFamily: Literata, fontSize: "clamp(32px..44px)", fontWeight: 400, lineHeight: 1.12, letterSpacing: -0.015em }
  subhead:   { fontFamily: Literata, fontSize: "clamp(26px..32px)", fontWeight: 400, lineHeight: 1.2 }
  statement: { fontFamily: Literata, fontSize: "clamp(28px..38px)", fontWeight: 400, lineHeight: 1.3 }
  quote:     { fontFamily: Literata, fontSize: "clamp(24px..30px)", fontWeight: 400, lineHeight: 1.4 }
  lg:        { fontFamily: Atkinson Hyperlegible, fontSize: 24px, fontWeight: 400, lineHeight: 1.5 }
  body:      { fontFamily: Atkinson Hyperlegible, fontSize: 22px, fontWeight: 400, lineHeight: 1.65 }
  sm:        { fontFamily: Atkinson Hyperlegible, fontSize: 18px, fontWeight: 400, lineHeight: 1.5 }
  button:    { fontFamily: Atkinson Hyperlegible, fontSize: 22px, fontWeight: 700, lineHeight: 1 }
  eyebrow:   { fontFamily: Atkinson Hyperlegible, fontSize: 16px, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0.08em, textTransform: uppercase }

rounded:
  field: 12px   # inputs, selects, error lines, skip link
  inset: 16px   # panels inside a card, choice cards, notes, toast
  card: 24px    # cards, quote cards, host cards
  full: 9999px  # buttons, pills, tabs on phones, tags, text-size toggle

spacing:
  base: 8px
  card-padding: "24px (phone) / 40px"
  band-padding: "clamp(64px..128px) vertical"
  stack: 24px
  section-gap: 56px   # heading block -> its list or grid

components:
  button-primary:   { backgroundColor: "{colors.rose}", textColor: "{colors.on-rose}", rounded: "{rounded.full}", minHeight: 64px, hover: "{colors.rose-dark}", active: "{colors.ink}" }
  button-secondary: { backgroundColor: "{colors.surface}", textColor: "{colors.rose}", border: "2px inset {colors.rose}", rounded: "{rounded.full}", minHeight: 64px, hover: "{colors.blush}" }
  button-link:      { textColor: "{colors.rose}", underline: true, minHeight: 48px, hover: "{colors.rose-dark} + 2px underline" }
  text-input:       { backgroundColor: "{colors.paper}", border: "2px {colors.field}", rounded: "{rounded.field}", minHeight: 64px, focus: "white fill, ink border, 4px ink ring" }
  choice-card:      { backgroundColor: "{colors.surface}", border: "2px {colors.field}", rounded: "{rounded.inset}", selected: "rose border + 2px rose halo on blush" }
  pill-choice:      { backgroundColor: "{colors.surface}", border: "2px {colors.muted}", rounded: "{rounded.full}", minHeight: 56px, selected: "ink fill, white text" }
  card:             { backgroundColor: "{colors.surface}", border: "1px {colors.line}", rounded: "{rounded.card}", padding: "{spacing.card-padding}", shadow: none }
  card-floating:    { extends: card, shadow: "{elevation.card}" }
  tag:              { backgroundColor: "{colors.blush}", textColor: "{colors.rose}", border: "1px rose at 50%", typography: "{typography.eyebrow}", rounded: "{rounded.full}" }
  header:           { backgroundColor: "{colors.paper}", border: "1px bottom {colors.line}" }
  footer:           { backgroundColor: "{colors.ink}", textColor: "{colors.paper}", focusRing: "{colors.paper}" }
  toast:            { backgroundColor: "{colors.ink}", textColor: white, rounded: "{rounded.inset}", shadow: "{elevation.overlay}" }
---

## Overview

Front Porch should feel like a letter on good paper from someone who is glad to hear from you. The page sits on a **warm paper** canvas (`{colors.paper}`), not white. White is kept for the things you touch and read closely: cards, fields, choices. Two soft fills, **blush** and **sage tint**, come in as full-width bands that pace the landing page like chapters. One color, **rose**, means "you can act here".

Users are 60 to 80, or a family member helping. So every craft choice below sits under the **Large & Calm** rules: big text, big targets, labels always shown, a strong focus ring, and no motion that people did not ask for.

What we took from Oura: the paper canvas, the serif-for-feeling / sans-for-facts split, light display weights where size makes the hierarchy, long quiet gaps between sections, hairlines over heavy borders, soft warm shadows, and the pill-buttons / soft-cards radius split. What we did not take: Oura's blue action color, its earth-tone palette, its thin (100 to 300) serif weights, its small 14 to 18px UI text, its photography-led layouts, and its silver product stage.

**Key Characteristics:**
- Warm paper canvas. White only for cards and controls.
- One accent: rose for buttons, links and selected states. Pink and sage never carry meaning alone.
- Literata at regular weight for headings; Atkinson Hyperlegible for everything you read and press.
- Bands cycle blush, paper, sage; the page ends on one dark ink footer band.
- Pills for actions, 24px cards for content, 16px for panels inside cards, 12px for fields.
- Flat by default. One soft lift for the main card on a screen, one stronger for the toast.

## Colors

### Brand & Accent
- **Rose** (`{colors.rose}`): primary buttons, secondary button outline and text, links, selected choice borders, tags, the progress bar. White on rose is above 5:1.
- **Rose dark** (`{colors.rose-dark}`): hover for anything rose.
- **Pink** (`{colors.pink}`): decorative rules (list rules, quote bars), step-number circles, illustration.
- **Sage** (`{colors.sage}`): illustration, list dots, success check marks. Never a button.

### Surface
- **Paper** (`{colors.paper}`): page background, header, the "paper" bands, resting input fill.
- **Surface** (`{colors.surface}`): cards, choice cards, pills, focused inputs.
- **Blush** (`{colors.blush}`): hero and alternate bands, selected choice fill, tag fill, host preview panel.
- **Sage tint** (`{colors.sage-tint}`): alternate bands, calm notes, live summaries ("Oscar will call you on...").
- **Ink band** (`{colors.ink}`): the footer only.
- **Line** (`{colors.line}`): 1px hairlines on paper and white.

### Text
- **Ink** (`{colors.ink}`): all body and heading text.
- **Muted** (`{colors.muted}`): hints, meta lines, review labels.
- **Paper** on ink: footer text.

### Semantic
- **Alert** (`{colors.alert}` on `{colors.alert-tint}`): error lines with a round "!" badge, invalid field border (3px).

## Typography

### Font Family
- **Literata** (display): a reading serif with an optical-size axis, so large headings get the finer display cut on their own. Used at 400 for headings, quotes, statements and summaries. 600 only for the logo, number badges and short bold labels.
- **Atkinson Hyperlegible** (body): built for low vision. Every paragraph, label, button and caption.

### Hierarchy

| Token | Family | Size | Weight | Use |
|---|---|---|---|---|
| `display` | Literata | 44 to 72px | 400 | Landing hero h1 |
| `heading` | Literata | 36 to 52px | 400 | Landing h2s, account page h1 |
| `title` | Literata | 32 to 44px | 400 | Sign-in, setup and done screen h1 |
| `subhead` | Literata | 26 to 32px | 400 | Step titles, card h2s |
| `statement` | Literata | 28 to 38px | 400 | Trust line, "what you need" list |
| `quote` | Literata | 24 to 30px | 400 | Questions, quotes, the host's line |
| `lg` | Atkinson | 24px | 400 | Lead paragraphs, field text |
| `body` | Atkinson | 22px | 400 | Default text (never smaller for reading) |
| `sm` | Atkinson | 18px | 400 | Hints, meta, footer |
| `eyebrow` | Atkinson | 16px | 700, caps, 0.08em | Tags only |

### Principles
- Serif for feeling, sans for facts.
- Size makes the hierarchy, not weight. Headings are 400.
- Tight tracking (-0.015 to -0.02em) only at heading sizes; body tracking stays 0.
- All sizes are rem, so the A / A+ / A++ toggle (100 / 115 / 130%) scales everything.

### Note on Font Substitutes
Oura's Editorial New is thin and high-contrast. We keep Literata: sturdier strokes read better for older eyes at every size. Fallbacks: Georgia for Literata, Verdana for Atkinson.

## Layout

### Spacing System
- **Base unit**: 8px. Common steps: 8, 12, 16, 24, 40, 56px.
- Card padding 24px on phones, 40px from 640px. Stacks inside a card: 24px.
- Landing bands: `clamp(64px, 48px + 5vw, 128px)` top and bottom.
- Heading block to its list or grid: 56px.

### Grid & Container
- Landing: 1120px max. Text plus art side by side from 896px (7/5, 5/7 or even), stacked below.
- Sign-in: art plus a 576px card from 960px; card alone below.
- Setup: one 640px column. Account: 896px column.
- 20px side gutters on phones, 32px from 640px. Works at 400px wide.

### Whitespace Philosophy
Empty paper is part of the design. Big gaps between bands tell people "new topic" without extra lines or labels. Inside cards, keep a steady 24px rhythm so the eye never has to hunt.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0 Flat | 1px `line` border, or a band color change | Default cards, bands, panels |
| 1 Card | `0 1px 2px ink/4%, 0 24px 48px -28px ink/22%` | The one main card on a screen (sign-in, setup step, done, example post) |
| 2 Overlay | `0 2px 6px ink/8%, 0 24px 48px -16px ink/30%` | Toast |

Shadows are warm (ink-tinted), soft and low. Never hard or grey.

## Shapes

| Token | Value | Use |
|---|---|---|
| `field` | 12px | Inputs, selects, error lines, skip link |
| `inset` | 16px | Choice cards, notes, panels inside cards, toast, desktop tab tops |
| `card` | 24px | Cards, quote and question cards, host cards |
| `full` | pill | Buttons, pill choices, phone tabs, tags, text-size toggle, progress bar |

## Components

### Buttons
- **Primary**: rose pill, white bold 22px, at least 64px tall, full width under 640px. Hover rose-dark, pressed ink. One primary per view where possible.
- **Secondary**: white pill with a 2px rose inset outline, rose text. Hover blush; pressed pink tint.
- **Link**: rose underlined text, at least 48px tall. Hover rose-dark with a 2px underline.
- **Small** (`small`): 48px tall, for in-card actions (save / cancel).
- Disabled: 60% opacity, not-allowed cursor. Busy: shows the busy label.

### Inputs & Forms
- Label always above, bold. Hint under the label in muted `sm`.
- Field: 64px, 12px radius, 2px `field` border, paper fill at rest. Hover and focus lift it to white; focus adds an ink border and the 4px ink ring.
- Error: 3px alert border, and an alert line under the field (role=alert).
- **Choice card**: whole card is the label for a real radio. 16px radius, white, 2px border; hover rose border; selected rose border, rose halo, blush fill and a filled rose check.
- **Pill choices** (days, times): 56px pills, white with muted border; hover rose border and blush; selected ink fill.

### Cards & Panels
- **Card**: white, 1px hairline, 24px radius, flat. Add `shadow-card` only for the main card of a screen.
- **Panels inside cards** (host preview, switch-host confirm, summaries, notes): 16px radius, blush or sage-tint fill, no shadow.
- **Tag**: small caps eyebrow in rose on blush, 1px soft rose border, pill.

### Navigation
- **Header**: paper, 1px hairline below. Logo left; text-size toggle and page actions right.
- **Text-size toggle**: segmented pill, white track, ink fill on the chosen size, 48px targets.
- **Account tabs**: two full-width pills on phones; from 640px, underline tabs with a 4px rose bar and blush hover.
- **Footer**: ink band, paper text, paper focus ring (`.on-ink`).

### Feedback
- **Toast**: ink, white bold text, 16px radius, overlay shadow, fades after 5s, read out politely.
- **Loading**: calm placeholder cards with soft blush bars (pulse stops under reduced motion).

## Do's and Don'ts

### Do
- Use paper as the page color; white only for cards and controls.
- Keep rose as the only action color. Keep pink and sage for fills, rules and art.
- Let size, not weight, lead headings. Keep body at 22px or more.
- Keep primary buttons at 64px and every other target at 48px or more.
- Always show labels. Always show the 4px focus ring (paper on the ink band).
- Give bands big vertical gaps; let the paper breathe.
- Prefer hairlines and band changes over shadows.
- Use the tokens (`text-heading`, `rounded-inset`, `shadow-card`, `.tag`) before one-off values.

### Don't
- Don't add a second accent color (no Oura blue, no earth tones on buttons).
- Don't use thin serif weights (below 400) or serif for small text.
- Don't put text under 18px, or reading text under 22px.
- Don't stack shadows or put shadows on every card.
- Don't hide labels in placeholders.
- Don't animate without `motion-safe`; reduced motion turns all animation off.
- Don't add sections, buttons or copy to "fill" space. Empty paper is fine.

## Responsive Behavior

| Width | Changes |
|---|---|
| under 560px | Header "Get started" button hides (hero button is right below) |
| under 640px | Primary buttons go full width; card padding 24px; tabs become two pills |
| 896px and up | Landing text and art sit side by side |
| 960px and up | Sign-in shows the reading art beside the card |

### Touch Targets
Primary 64px, secondary and links 48px, pill choices 56px, choice cards 72px.

### Collapsing Strategy
Splits stack text first, art after (art first only where the layout flips on desktop). Quote grid goes 2-up to 1-up. Arbitrary breakpoints use px only (`min-[896px]:`); never mix px and rem in them.

## Agent Prompt Guide

When building or changing a screen:
1. Page on `bg-paper`. Content in a `Card` (white, hairline). Lift only the main card with `shadow-card`.
2. h1 uses `text-display` (landing hero), `text-heading` (landing h2, account h1) or `text-title` (task screens). Card h2 uses `text-subhead`.
3. Actions use `Button` (primary / secondary / link). Fields use `TextField` / `SelectField` / `ChoiceCard` / `PillChoices`.
4. Panels inside cards: `rounded-inset` with `bg-blush` or `bg-sage-tint`.
5. Labels for state: `.tag`.
6. Check: 22px body, 64px primary, 48px other targets, labels visible, focus ring visible, works at 400px, A++ does not break layout, nothing moves under reduced motion.
