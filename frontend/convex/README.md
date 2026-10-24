# Convex functions

Database tables and functions for Front Porch. The React app reads with the
public queries; only the Python backend can write, because every write (and
every private read) needs `secret`, which must match `BACKEND_SECRET`.

## Run

From `frontend/`:

```bash
npx convex dev
```

The first run logs you in, creates a deployment, writes `VITE_CONVEX_URL` to
`frontend/.env.local`, and generates `convex/_generated/`.

Then set the shared secret (use the same value as `CONVEX_BACKEND_SECRET` in
the backend's `.env`):

```bash
npx convex env set BACKEND_SECRET your-long-random-string
```

## Files

| File | What it holds |
|---|---|
| `schema.ts` | tables: elders, questions, calls, answers, replies |
| `elders.ts` | people who answer by phone (public list masks phone numbers) |
| `questions.ts` | questions found online, their status and assigned elder |
| `calls.ts` | live call transcripts |
| `answers.ts` | AI-written answers, approval status, per-platform publish results |
| `replies.ts` | thank-yous read back to the elder on their next call |
| `lib/auth.ts` | `BACKEND_SECRET` check and small helpers |
