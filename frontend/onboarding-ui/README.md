# Onboarding for older adults

React 18 + Vite + Tailwind CSS 3. Three steps: sign in or register, phone with a 6-digit code, optional LinkedIn.
Spanish by default, English toggle in the top right.

```bash
npm install
npm run dev     # http://localhost:5173
npm run build
```

## Where things live

- `tailwind.config.js` palette (rosa, cempasuchil, talavera, lino, tinta), fonts, 20px body size, 60px touch height
- `src/index.css` Talavera tile band, focus ring, reduced-motion rule
- `src/i18n.js` all copy in ES and EN, plus the country list
- `src/api.js` mock auth API. Replace each function with a real provider.
  Demo triggers: password `error1234` shows the wrong-password error, code `000000` shows the wrong-code error.
- `src/ui.jsx` Button, fields, badge, step header, icons
- `src/App.jsx` the flow and its state

Progress is saved in `sessionStorage`. The password and the SMS code are never stored.

## Replace the placeholder

The final button on the "done" screen calls `window.alert`. Replace it with your own navigation.
