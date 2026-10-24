# Onboarding web app

A short sign-up flow where a person (or someone helping them) signs up for Front Porch calls.
React 18 + Vite + Tailwind CSS 3. Spanish by default, English toggle in the top right. Big text, 60px buttons.

```
sign in ──► name + phone ──► SMS code ──► who calls ──► LinkedIn ──► done
 (fake)                       (fake)       (Convex)     (optional)   "Call me now"
                                │
                                └─► Convex signup:register
```

## Run it

```bash
npm install
cp .env.example .env.local   # sets VITE_CONVEX_URL
npm run dev                  # http://localhost:5173
npm run build
```

## Where things live

- `src/App.jsx` the flow and its state
- `src/steps/` one file per screen
- `src/backend.js` calls to Convex (`convex/signup.ts`): `listCharacters`, `register`, `setCharacter`, `setLinkedin`, `requestCall`
- `src/api.js` fake sign-in and SMS code. Demo triggers: password `error1234`, code `000000`
- `src/i18n.js` all copy in ES and EN, plus the country list
- `src/phone.js` phone formatting and E.164
- `src/ui.jsx` buttons, fields, headers, icons
- `tailwind.config.js` palette, fonts, sizes

Progress is kept in `sessionStorage`; the elder id in `localStorage`. The password and the SMS code are never stored.
