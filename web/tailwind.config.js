/** @type {import('tailwindcss').Config} */
// Palette strategy: five named families taken from the cultural references.
//  rosa        Rosa Mexicano, primary actions (600 is the button fill: white text on it is above 5.5:1)
//  cempasuchil marigold, soft badges and highlights (400 fill takes dark text)
//  talavera    cobalt of Talavera tile, borders, links and the focus ring
//  lino        warm linen surfaces, the page background
//  tinta       warm near-black ink for text (900 on lino-100 is above 12:1)
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        rosa: { 100: '#FBE3EF', 500: '#E4007C', 600: '#C4006B', 700: '#A30058' },
        cempasuchil: { 300: '#F9CD74', 400: '#F4B23E', 700: '#8A5200' },
        talavera: { 600: '#2A62A8', 700: '#1F4E8C', 900: '#12305A' },
        lino: { 50: '#FDF9F1', 100: '#F5EDE0', 300: '#D2C1A8' },
        tinta: { 700: '#5A4C42', 900: '#2A211C' },
        alerta: { 100: '#FCE9E6', 700: '#A31515' },
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['"Atkinson Hyperlegible"', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        base: ['1.25rem', { lineHeight: '1.6' }], // 20px body
        lg: ['1.375rem', { lineHeight: '1.5' }],
        xl: ['1.25rem', { lineHeight: '1.4' }],
        '3xl': ['2.125rem', { lineHeight: '1.15' }],
      },
      minHeight: { touch: '3.75rem' }, // 60px
      keyframes: {
        rise: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: { rise: 'rise 150ms ease-out both' },
    },
  },
  plugins: [],
}
