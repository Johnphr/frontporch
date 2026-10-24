import { Button, ErrorBanner, LinkedInIcon, ScreenHeader, TextField } from '../ui'

// Screen 4: LinkedIn profile link (optional).
export default function LinkedIn({ t, headingRef, busy, error, fieldErrors, url, setUrl, onSave, onSkip }) {
  return (
    <>
      <ScreenHeader headingRef={headingRef} title={t.s3.title} lead={t.s3.lead} />
      <form noValidate onSubmit={onSave} className="flex flex-1 flex-col gap-5">
        <TextField
          id="linkedin"
          type="url"
          inputMode="url"
          autoComplete="url"
          label={t.s3.url}
          hint={t.s3.urlHint}
          error={fieldErrors.linkedin}
          placeholder="linkedin.com/in/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div className="flex-1" />
        <ErrorBanner>{error}</ErrorBanner>
        <div className="flex flex-col gap-4">
          <Button type="submit" icon={<LinkedInIcon />} disabled={busy}>
            {busy ? t.working : t.s3.save}
          </Button>
          <Button variant="secondary" onClick={onSkip} disabled={busy}>
            {t.s3.skip}
          </Button>
        </div>
      </form>
    </>
  )
}
