# Onboarding for older adults (sign-up page)

React 18 + Vite + Tailwind CSS 3. Design by Mafer (`feat/onboarding-ui`), wired to the public
sign-up API in `convex/signup.ts`. Spanish by default, English toggle in the top right.

Four steps, then a "Call me now" button:

| Step | Screen | Convex function (`convex/signup.ts`) |
|---|---|---|
| 1 | Name + call language (Español / English); the language also sets the page language until the toggle is used | none (validated locally, sent in step 2) |
| 2 | Phone number | `signup:register({ name, phone, language })` → `elderId` (an existing number returns its id, nothing changes) |
| 3 | Who calls you (characters in the chosen language) | `signup:listCharacters`, `signup:setCharacter({ elderId, characterId })` |
| 4 | LinkedIn profile link, optional ("Skip for now") | `signup:setLinkedin({ elderId, url })` |
| done | "Call me now" | `signup:requestCall({ elderId })`: rings only when the backend allows it (`PUBLIC_CALLS=on` rings numbers in `CALL_ALLOWLIST`, `=all` rings anyone); otherwise the page says calls are turned off |

There are no accounts (the backend has none) and no SMS verification yet: the 6-digit code
screen still exists but is skipped (`VERIFY_PHONE = false` in `src/App.jsx`, mock in
`src/api.js` `phoneVerification`). Turn it on once real SMS verification exists.

## Setup

```bash
npm install
cp .env.example .env.local        # set VITE_CONVEX_URL
npm run dev                       # http://localhost:5173
npm run build
```

`VITE_CONVEX_URL` is the Convex deployment URL (`https://<name>.convex.cloud`, in the Convex
dashboard under Settings). That deployment must have `convex/signup.ts` deployed
(`feat/characters` or later). It's read at build time; without it the page shows a
"not set up yet" screen instead of the form.

## Deploy to Vercel

Preview (from the repo root, after `npx vercel login`):

```bash
npx vercel deploy --cwd frontend/onboarding-ui --build-env VITE_CONVEX_URL=https://<deployment>.convex.cloud
```

The first run links the folder to a Vercel project (it asks which scope and project name).
For later deploys, set `VITE_CONVEX_URL` once in the Vercel project (Settings → Environment
Variables, for Preview and Production) so you can drop `--build-env`. Production:
`npx vercel deploy --prod --cwd frontend/onboarding-ui`. `vercel.json` pins the Vite build;
there are no client-side routes, so no rewrites are needed.

## Where things live

- `tailwind.config.js` palette (rosa, cempasuchil, talavera, lino, tinta), fonts, 20px body size, 60px touch height
- `src/index.css` Talavera tile band, focus ring, reduced-motion rule
- `src/i18n.js` all copy in ES and EN, plus the country list. Backend error messages (English only)
  are mapped to these by `src/api.js`
- `src/api.js` the Convex calls (`ConvexHttpClient` + `anyApi`, no codegen) and the SMS mock
- `src/ui.jsx` Button, fields, radio cards, badge, step header, icons
- `src/App.jsx` the flow and its state

Progress (name, language, phone, chosen character, sign-up id) is saved in `sessionStorage` so a
refresh doesn't lose it. The SMS code and the LinkedIn link are never stored.
