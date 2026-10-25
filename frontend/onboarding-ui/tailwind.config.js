/** @type {import('tailwindcss').Config} */
// "Large & Calm" with Oura-style craft (see DESIGN.md). Text is ink on warm paper / white; rose is
// the only accent used for text and buttons (white on rose is above 5:1). Pink and sage are fills only.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#3A2A2E',
        rose: { DEFAULT: '#A8475E', dark: '#8E3A4F' },
        pink: { DEFAULT: '#F2B8C6', tint: '#F7D6DE' },
        blush: '#FCEEF1',
        paper: '#FBF7F3', // warm paper canvas (Oura's cream, nudged toward our blush)
        sage: { DEFAULT: '#8FAE9B', tint: '#E6EEE9', deep: '#6F9180' },
        line: '#EBD3DA',
        muted: '#6B5359',
        field: '#8C6F77',
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
      minHeight: { touch: '4rem', 'touch-sm': '3rem' },
      borderRadius: { card: '1.5rem', inset: '1rem', field: '0.75rem' },
      // Soft, warm, low-opacity. Flat is the default; these are the only two lifts.
      boxShadow: {
        card: '0 1px 2px rgba(58, 42, 46, 0.04), 0 1.5rem 3rem -1.75rem rgba(58, 42, 46, 0.22)',
        overlay: '0 2px 6px rgba(58, 42, 46, 0.08), 0 1.5rem 3rem -1rem rgba(58, 42, 46, 0.3)',
      },
      keyframes: {
        rise: { from: { opacity: '0', transform: 'translateY(0.5rem)' }, to: { opacity: '1', transform: 'none' } },
        ring: { '0%, 100%': { opacity: '0.25' }, '50%': { opacity: '1' } },
      },
      animation: { rise: 'rise 0.35s ease-out both', ring: 'ring 2.6s ease-in-out infinite' },
    },
  },
  plugins: [],
}
