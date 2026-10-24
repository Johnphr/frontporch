# Vapi setup

Pip's live calls run in Vapi. This folder keeps the assistant config in the repo
so it isn't trapped in someone's dashboard. Owner: Voice stream.

`<convex.site>` below = `https://<deployment>.convex.site` (shown in the Convex
dashboard). Use the shared dev deployment while building, production for the demo.

| File | What |
|---|---|
| `conversation-guide.md` | How Pip talks: research-backed rules + speech settings |
| `prompts/onboarding.md` | First call: get to know him |
| `prompts/story-call.md` | Weekly call: one story, guided by the plan |

## Checklist

1. **Import the Twilio number** into Vapi (Phone Numbers → Import → Twilio).
2. **Create two assistants**, "Pip – onboarding" and "Pip – story":
   - System prompt: the matching file in `prompts/` (everything below the `---`)
   - Model: fast Claude model offered by Vapi (open decision 11)
   - Voice: Cartesia (add the Cartesia key under Provider Keys)
   - Transcriber: language overridden per call from `elders.language` (open decision 12)
   - Speech settings: see `conversation-guide.md` → "Vapi settings that let him talk"
   - Voicemail detection on (open decision 13); Analysis → summary on
3. **Server URL** on both: `<convex.site>/vapi/webhook`, with a secret
   (`VAPI_WEBHOOK_SECRET`). Events: `end-of-call-report` (required), `status-update`.
4. In Convex env: `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`,
   `VAPI_ONBOARDING_ASSISTANT_ID`, `VAPI_STORY_ASSISTANT_ID`, `VAPI_WEBHOOK_SECRET`.

Record the final settings here once they work (model, voice id, transcriber,
endpointing values) so anyone can rebuild the assistants.
