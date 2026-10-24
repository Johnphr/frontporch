# Vapi setup

Pip's live call runs in Vapi. This folder keeps the assistant config in the repo
so it isn't trapped in someone's dashboard. Owner: Voice stream.

## Checklist

1. **Import the Twilio number** into Vapi (Phone Numbers → Import → Twilio).
   Then set the number's *Messaging* webhook in Twilio to
   `https://<backend>/sms/inbound`. Voice stays with Vapi.
2. **Create the assistant "Pip"**
   - Model: fast Claude model offered by Vapi (open decision 4)
   - Voice: Cartesia, same voice id as `CARTESIA_VOICE_ID`
   - Transcriber: language overridden per call from `elders.language` (open decision 5)
   - System prompt: `pip-system-prompt.md`
   - Voicemail detection on (open decision 11)
   - Analysis → summary on (feeds `CallResult.summary`)
3. **Server URL**: `https://<backend>/vapi/webhook`, with a secret
   (`VAPI_WEBHOOK_SECRET`). Events: `end-of-call-report` (required), `status-update`.
4. Put `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID` in Convex env.

Record the final assistant settings here once they work (model, voice id,
transcriber, endpointing) so anyone can rebuild it.
