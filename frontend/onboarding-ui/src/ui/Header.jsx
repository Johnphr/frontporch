import { NAV } from '../copy'
import { TEXT_SIZES, useTextSize } from '../lib/textSize'

export function Logo({ href = '#/', tone = 'text-ink' }) {
  return (
    <a href={href} className={`inline-flex items-center gap-2.5 font-display text-[1.625rem] font-semibold no-underline ${tone}`}>
      <svg viewBox="0 0 32 32" className="h-9 w-9" aria-hidden="true" focusable="false">
        <path d="M3 15 L16 4 L29 15 Z" fill="#A8475E" />
        <rect x="7" y="15" width="18" height="13" rx="2" fill="#F2B8C6" />
        <rect x="13.5" y="19" width="5" height="9" rx="1" fill="#A8475E" />
      </svg>
      {NAV.brand}
    </a>
  )
}

export function TextSizeToggle() {
  const [size, setSize] = useTextSize()
  return (
    <div className="inline-flex items-center gap-2" role="group" aria-labelledby="size-label">
      <span id="size-label" className="text-[1rem] font-bold">
        {NAV.textSize}
      </span>
      <span className="inline-flex gap-1 rounded-full border border-line bg-white p-1">
        {TEXT_SIZES.map((s, i) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={size === s.id}
            aria-label={s.aria}
            onClick={() => setSize(s.id)}
            className={`min-h-touch-sm min-w-[3rem] rounded-full px-2 font-bold leading-none transition-colors ${
              size === s.id ? 'bg-ink text-white' : 'text-ink hover:bg-blush'
            }`}
            style={{ fontSize: `${1.0625 + i * 0.1875}rem` }}
          >
            {s.label}
          </button>
        ))}
      </span>
    </div>
  )
}

/** Top bar on every page: logo, text size, and whatever the page puts on the right (children). */
export function Header({ children, below }) {
  return (
    <header className="border-b border-line bg-paper">
      <a href="#main" className="absolute -top-40 left-4 z-10 rounded-field bg-ink px-6 py-4 font-bold text-white no-underline focus:top-4">
        {NAV.skip}
      </a>
      <div className="mx-auto flex max-w-[70rem] flex-wrap items-center justify-between gap-x-6 gap-y-4 px-5 py-4 sm:px-8">
        <Logo />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
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
    <footer className="on-ink bg-ink py-16 text-sm text-paper">
      <div className="mx-auto flex max-w-[70rem] flex-col gap-3 px-5 sm:px-8">
        <Logo tone="text-paper" />
        <p>{NAV.alsoSpanish}</p>
        <p>{NAV.builtAt}</p>
      </div>
    </footer>
  )
}
