# Front Porch web app

React 18 + Vite + Tailwind CSS 3, plain JSX. "Large & Calm" design: big type, 64px buttons,
A / A+ / A++ text size. English only. Talks to `convex/signup.ts` and `convex/account.ts`.

```
#/        landing ──► #/signin ──► #/setup ──► #/home  (Home | Posts)
                       │  already set up on this device ──────▲
```

| Route | Screen | Convex functions |
|---|---|---|
| `#/` | Landing | none |
| `#/signin` | Phone number or email (no code or link yet) | none |
| `#/setup` | Who sets up, name, language + host, weekly day + time, LinkedIn, review, Finish, call status | `signup:register`, `signup:setCharacter`, `account:setSchedule`, `signup:setLinkedin`, `signup:requestCall`, `signup:callStatus` |
| `#/home` | Switch host, change call day/time | `account:getProfile`, `signup:setCharacter`, `account:setSchedule` |
| `#/posts` | Published posts with reaction/comment counts | `account:listPosts` |

**No real sign-in yet.** No code or link is asked for; the device
remembers `{ phone, elderId }` in `localStorage` (`src/lib/session.js`). Anyone with the link
and an elderId can see that page, so keep the link private until real auth exists.
`requestCall` only rings when the backend allows it (`PUBLIC_CALLS`); otherwise the last screen
says when the host will call.

## Setup

```bash
npm install
cp .env.example .env.local        # set VITE_CONVEX_URL
npm run dev                       # http://localhost:5173
npm run build
```

`VITE_CONVEX_URL` is the Convex deployment URL (`https://<name>.convex.cloud`, in the Convex
dashboard under Settings). It's read at build time. Optional `VITE_PORCH_NUMBER` (E.164) shows "Call your host any time at …" on Home and
the last setup screen, for inbound calls; hidden when unset. Without it, the landing page still shows,
and the other screens say "not set up yet".

## Deploy to Vercel

```bash
npx vercel deploy --cwd frontend/onboarding-ui --build-env VITE_CONVEX_URL=https://<deployment>.convex.cloud
```

Set `VITE_CONVEX_URL` once in the Vercel project (Settings → Environment Variables) to drop
`--build-env`. Production: `npx vercel deploy --prod --cwd frontend/onboarding-ui`. Routes are
hash-based, so `vercel.json` needs no rewrites.

## Where things live

- `tailwind.config.js`: colors (ink, rose, pink, blush, sage), fonts (Literata, Atkinson Hyperlegible), sizes
- `src/App.jsx`: routes. `src/lib/`: hash routing, session, text size, call-status polling
- `src/api.js`: Convex calls (`ConvexHttpClient` + `anyApi`, no codegen) and error codes
- `src/copy.js`: shared copy and error messages. `src/copy/<page>.js` holds each page's copy
- `src/ui/`: header, buttons, fields, choice cards, toast. `src/art/`: the SVG illustrations
- `src/pages/`: `Landing`, `SignIn`, `setup/*` (onboarding), `account/*` (Home + Posts)
