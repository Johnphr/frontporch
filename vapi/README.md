# Vapi setup

Pip's live call runs in Vapi. This folder keeps the assistant config in the repo
so it isn't trapped in someone's dashboard. Owner: Voice stream.

`<convex.site>` below = `https://<deployment>.convex.site` (shown in the Convex
dashboard). Use the shared dev deployment while building, production for the demo.

## Checklist

1. **Import the Twilio number** into Vapi (Phone Numbers → Import → Twilio).
   Then in Twilio set the number's *Messaging* webhook to
   `<convex.site>/sms/inbound` (HTTP POST). Voice stays with Vapi.
2. **Create the assistant "Pip"**
   - Model: fast Claude model offered by Vapi (open decision 2)
   - Voice: Cartesia (add the Cartesia key under Provider Keys)
   - Transcriber: language overridden per call from `elders.language` (open decision 3)
   - System prompt: `pip-system-prompt.md`
   - Voicemail detection on (open decision 9)
   - Analysis → summary on (feeds `CallResult.summary`)
3. **Server URL**: `<convex.site>/vapi/webhook`, with a secret
   (`VAPI_WEBHOOK_SECRET`). Events: `end-of-call-report` (required), `status-update`.
4. Put `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`,
   `VAPI_WEBHOOK_SECRET` in Convex env (`npx convex env set ...`).

Record the final assistant settings here once they work (model, voice id,
transcriber, endpointing) so anyone can rebuild it.
