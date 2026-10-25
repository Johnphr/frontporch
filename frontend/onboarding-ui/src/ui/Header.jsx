import { NAV } from '../copy'
import { TEXT_SIZES, useTextSize } from '../lib/textSize'

// Speech bubble whose tail is a curly phone cord (design-mockups/logo/final/frontporch-symbol.svg).
const LOGO_PATH =
  'M88 128 A48 48 0 0 1 40 80 V56 A48 48 0 0 1 88 8 H168 A48 48 0 0 1 216 56 V80 A48 48 0 0 1 168 128 H124 A12 12 0 0 0 112 140 L112 142 C112.7 145.0 113.7 155.0 116.4 160.2 C119.0 165.4 123.6 170.3 127.9 173.3 C132.2 176.3 137.8 177.8 142.1 178.0 C146.4 178.2 151.0 176.4 153.6 174.4 C156.3 172.3 158.0 168.5 158.0 165.6 C158.0 162.6 156.3 158.8 153.6 156.8 C151.0 154.7 146.4 152.9 142.1 153.1 C137.8 153.3 132.2 154.9 127.9 157.8 C123.6 160.8 119.0 165.7 116.4 170.9 C113.7 176.1 112.0 183.0 112.0 189.1 C112.0 195.2 113.7 202.1 116.4 207.4 C119.0 212.6 123.6 217.5 127.9 220.4 C132.2 223.4 137.8 225.0 142.1 225.1 C146.4 225.3 151.0 223.6 153.6 221.5 C156.3 219.4 158.0 215.6 158.0 212.7 C158.0 209.8 156.3 206.0 153.6 203.9 C151.0 201.8 146.4 200.1 142.1 200.2 C137.8 200.4 132.2 202.0 127.9 204.9 C123.6 207.9 119.0 212.8 116.4 218.0 C113.7 223.2 112.7 232.9 112.0 236.2'

export function Logo({ href = '#/', tone = 'text-ink' }) {
  // Rose mark on light backgrounds; soft pink on the dark footer.
  const markTone = tone === 'text-white' ? 'text-pink' : 'text-rose'
  return (
    <a href={href} className={`inline-flex items-center gap-2.5 font-display text-[1.625rem] font-semibold no-underline ${tone}`}>
      <svg viewBox="0 0 256 256" className={`h-9 w-9 ${markTone}`} aria-hidden="true" focusable="false">
        <path d={LOGO_PATH} fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {NAV.brand}
    </a>
  )
}

/** The one look for every plain item in the top bar: ink text, soft fill on hover, rose wash when selected. */
export const NAV_ITEM =
  'inline-flex min-h-touch-sm items-center justify-center rounded-full px-4 text-sm font-bold text-ink no-underline transition-colors hover:bg-wash'

export function TextSizeToggle() {
  const [size, setSize] = useTextSize()
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-labelledby="size-label">
      <span id="size-label" className="pr-1 text-sm text-muted">
        {NAV.textSize}
      </span>
      {TEXT_SIZES.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-pressed={size === s.id}
          aria-label={s.aria}
          onClick={() => setSize(s.id)}
          className={`${NAV_ITEM} min-w-[3rem] !px-2 ${size === s.id ? '!bg-rose-wash !text-rose' : ''}`}
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}

/** Top bar on every page: logo, text size, and whatever the page puts on the right (children). */
export function Header({ children, below }) {
  return (
    <header className="border-b border-line bg-white">
      <a href="#main" className="absolute -top-40 left-4 z-10 rounded-field bg-ink px-6 py-4 font-bold text-white no-underline focus:top-4">
        {NAV.skip}
      </a>
      <div className="mx-auto flex max-w-[70rem] flex-wrap items-center justify-between gap-x-6 gap-y-4 px-5 py-4 sm:px-8">
        <Logo />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <TextSizeToggle />
          {children}
        </div>
      </div>
      {below}
    </header>
  )
}

export function Footer() {
  return (
    <footer className="on-ink bg-ink py-16 text-sm text-white">
      <div className="mx-auto flex max-w-[70rem] flex-col gap-3 px-5 sm:px-8">
        <Logo tone="text-white" />
        <p>{NAV.alsoSpanish}</p>
        <p>{NAV.builtAt}</p>
      </div>
    </footer>
  )
}
