# Front Porch web app

React 18 + Vite + Tailwind CSS 3, plain JSX. "Large & Calm" design: big type, 64px buttons,
A / A+ / A++ text size. English page (error and connect copy also in Spanish). Talks to `convex/signup.ts` and `convex/account.ts`.

```
#/        landing ──► #/signin ──► #/setup ──► #/home  (Home | Posts)
                       │  already set up on this device ──────▲
```

| Route | Screen | Convex functions |
|---|---|---|
| `#/` | Landing | none |
| `#/signin` | Phone + 6-digit code, or email link | none yet (both mocked in `src/api.js`) |
| `#/setup` | 1 who sets up, 2 name, 3 language + host, 4 weekly day + time, 5 review → save, 6 connect accounts (optional) → Finish rings him, then call status | 5: `signup:register({ name, phone, language, timeZone })` → `{ elderId, token }` (an existing number gets `already_signed_up`: no id, no token, a kind message), `signup:setCharacter`, `account:setSchedule`. 6: `signup:connectBluesky({ elderId, token, handle, appPassword })`, `signup:startOAuthConnect({ elderId, token, platform })` for Threads and X, then `signup:requestCall`, `signup:callStatus` |
| `#/home` | Switch host, change call day/time | `account:getProfile`, `signup:setCharacter`, `account:setSchedule` |
| `#/posts` | Posts that went out, a link per platform, reaction/comment counts | `account:listPosts` |

**No real sign-in yet.** Any code works, except `000000`, which shows the "wrong code" error. The device
remembers `{ phone, elderId, token }` in `localStorage` (`src/lib/session.js`); the token comes from
`register`, and every call after it sends it, so an elderId alone opens nothing. A saved elderId
without a token (older version) is dropped. Keep the link private until real auth exists.
`requestCall` only rings when the backend allows it (`PUBLIC_CALLS`); otherwise the last screen
says when Pip will call.

**Threads / X round trip.** "Connect Threads" / "Connect X" leave the site for the platform's
consent page; the backend's callback sends him back to `SIGNUP_SITE_URL` with `?connected=<id>` or
`?connect_error=<code>&platform=<id>` (`src/lib/oauthReturn.js`). The app removes those from the
address bar and reopens setup step 6 (progress is in `sessionStorage`, never the app password or
token), which shows the result. Posting on X costs a few cents per post, so it's off unless the
team turns it on (`X_POSTING`).

**Copy.** English page. Every backend error code (sign-up, Bluesky connect, OAuth connect, call
reasons and states) has English and Spanish text: `src/copy.js` (`ERRORS`, `CALL_STATUS_BY_LANG`)
and `src/copy/accounts.js`.

## Setup

```bash
npm install
cp .env.example .env.local        # set VITE_CONVEX_URL
npm run dev                       # http://localhost:5173
npm run build
```

`VITE_CONVEX_URL` is the Convex deployment URL (`https://<name>.convex.cloud`, in the Convex
dashboard under Settings). It's read at build time. Without it, the landing page still shows,
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
- `src/api.js`: Convex calls (`ConvexHttpClient` + `anyApi`, no codegen), error codes, and the sign-in mocks
- `src/copy.js`: shared copy and error messages (EN + ES). `src/copy/<page>.js` holds each page's copy
- `src/ui/`: header, buttons, fields, choice cards, toast. `src/art/`: the SVG illustrations
- `src/pages/`: `Landing`, `SignIn`, `setup/*` (onboarding; `Accounts.jsx` + `OAuthConnect.jsx` = step 6), `account/*` (Home + Posts)
