/** @type {import('tailwindcss').Config} */
// "Large & Calm", quiet edition (see DESIGN.md). Ink on white; one soft wash for notes; rose is the
// only accent (actions, links, selected). Pink and sage live in the illustrations only.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#3A2A2E',
        rose: { DEFAULT: '#A8475E', dark: '#8E3A4F', wash: '#FBF1F4' }, // wash: selected / pressed fill
        wash: '#F7F6F5', // the one neutral fill: notes, summaries, one landing band
        pink: '#F2B8C6', // illustration only
        sage: '#8FAE9B', // illustration only
        line: '#E5E1E2',
        muted: '#66605F',
        field: '#8A8385',
        alert: { DEFAULT: '#A3242F', tint: '#FBE4E8' },
      },
      fontFamily: {
        display: ['Literata', 'Georgia', '"Times New Roman"', 'serif'],
        sans: ['"Atkinson Hyperlegible"', 'Verdana', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        base: ['1.375rem', { lineHeight: '1.65' }], // 22px body
        sm: ['1.125rem', { lineHeight: '1.5' }],
        lg: ['1.5rem', { lineHeight: '1.5' }],
        // Editorial serif scale: size, not weight, makes the hierarchy.
        display: ['clamp(2.75rem, 1.6rem + 4.4vw, 4.5rem)', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        heading: ['clamp(2.25rem, 1.5rem + 2.6vw, 3.25rem)', { lineHeight: '1.1', letterSpacing: '-0.015em' }],
        title: ['clamp(2rem, 1.6rem + 1.6vw, 2.75rem)', { lineHeight: '1.12', letterSpacing: '-0.015em' }],
        subhead: ['clamp(1.625rem, 1.3rem + 1.2vw, 2rem)', { lineHeight: '1.2' }],
        statement: ['clamp(1.75rem, 1.4rem + 1.4vw, 2.375rem)', { lineHeight: '1.3' }],
        quote: ['clamp(1.5rem, 1.25rem + 1vw, 1.875rem)', { lineHeight: '1.4' }],
        eyebrow: ['1rem', { lineHeight: '1.2', letterSpacing: '0.08em' }],
      },
      // px floors keep targets tappable when the root size drops to 80% on desktop.
      minHeight: { touch: 'max(4rem, 52px)', 'touch-sm': 'max(3rem, 44px)' },
      borderRadius: { card: '1.5rem', inset: '1rem', field: '0.75rem' },
      // Soft, warm, low-opacity. Flat is the default; these are the only two lifts.
      boxShadow: {
        card: '0 1px 2px rgba(58, 42, 46, 0.04), 0 1.5rem 3rem -1.75rem rgba(58, 42, 46, 0.22)',
        overlay: '0 2px 6px rgba(58, 42, 46, 0.08), 0 1.5rem 3rem -1rem rgba(58, 42, 46, 0.3)',
      },
      // Motion: a strong ease-out (built-in is too weak), short UI durations, transform + opacity only.
      transitionTimingFunction: { out: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      keyframes: {
        // Setup steps slide the way you are going: forward from the right, Back from the left.
        rise: { from: { opacity: '0', transform: 'translateX(1.5rem)' }, to: { opacity: '1', transform: 'none' } },
        'rise-back': { from: { opacity: '0', transform: 'translateX(-1.5rem)' }, to: { opacity: '1', transform: 'none' } },
        // Panels, notes and errors that appear in place.
        enter: { from: { opacity: '0', transform: 'translateY(-0.375rem)' }, to: { opacity: '1', transform: 'none' } },
        // A check mark landing in its circle.
        pop: { from: { opacity: '0', transform: 'scale(0.6)' }, to: { opacity: '1', transform: 'none' } },
        ring: { '0%, 100%': { opacity: '0.25' }, '50%': { opacity: '1' } },
        // Ripple behind the live call dot.
        beacon: { from: { opacity: '0.5', transform: 'scale(1)' }, to: { opacity: '0', transform: 'scale(2.6)' } },
      },
      animation: {
        rise: 'rise 0.3s cubic-bezier(0.23, 1, 0.32, 1) both',
        'rise-back': 'rise-back 0.3s cubic-bezier(0.23, 1, 0.32, 1) both',
        enter: 'enter 0.22s cubic-bezier(0.23, 1, 0.32, 1) both',
        pop: 'pop 0.18s cubic-bezier(0.23, 1, 0.32, 1) both',
        ring: 'ring 2.6s ease-in-out infinite',
        beacon: 'beacon 1.6s cubic-bezier(0.23, 1, 0.32, 1) infinite',
      },
    },
  },
  plugins: [],
}
