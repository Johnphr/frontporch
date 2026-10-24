# Front Porch

**Grandpa tells his stories over a weekly phone call. His family gets them as LinkedIn posts. No app, no screen, no passwords.**

Every week Pip, a warm AI phone host, calls an older adult and asks them one
question: something a grandkid texted in ("Ask grandpa how he met grandma"),
or, if nobody did, a real question someone asked online. Pip remembers past
calls. Afterwards their answer is written up from their own words, posted to
their LinkedIn, and the family gets a text with the link.

Built at Cal Hacks 13.0.

> **Status:** v2 structure only. See **[ARCHITECTURE.md](ARCHITECTURE.md)** for
> flows, contracts, data model, open decisions and who owns what.

## Stack

| Piece | Tech |
|---|---|
| Backend, database, vector memory, crons, webhooks | Convex (`convex/`) |
| Live call | Vapi (`vapi/`) on a Twilio number, Cartesia voice |
| Family questions + notifications | Twilio SMS → Convex HTTP action |
| Writing posts, memories, triage | Claude (`claude-opus-5-5`) |
| Embeddings | OpenAI `text-embedding-3-small` |
| Posting | LinkedAPI (grandpa's own LinkedIn account) |
| Online fallback questions | Apify |

## Setup

```bash
npm install
npx convex dev          # log in, pick the team project; keep it running
npx convex env set ANTHROPIC_API_KEY <value>   # repeat for each key
```

The full list of keys is in [ARCHITECTURE.md → Env vars](ARCHITECTURE.md#env-vars-all-in-convex).
Vapi and Twilio setup: [vapi/README.md](vapi/README.md).
Demo data (grandpa + family numbers) is added by hand in the Convex dashboard.

## Safety

- Posts use **only what the person said**; the prompt forbids adding facts or advice.
- Claude skips online questions that need a licensed professional (medical,
  legal, financial), crisis topics, or requests for personal info.
- Every post says it was written up with AI from a phone call.
- Posts go out automatically, without review. Speech-to-text mistakes reach
  LinkedIn, so the family is texted right away with the link (undo flow: open decision 8).
- Only registered family numbers can text questions in; others are ignored.

## History

v1 (online questions answered via a Twilio `<Gather>` flow, FastAPI backend,
React dashboard) lives in commit `9e67aab`. What's worth porting is listed in
[ARCHITECTURE.md → Port from v1](ARCHITECTURE.md#port-from-v1).
