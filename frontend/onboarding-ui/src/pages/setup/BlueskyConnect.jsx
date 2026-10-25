// The Bluesky connect form (signup:connectBluesky): how-to, handle, app password (show / hide),
// the safety note, and Connect. Used by setup step 6 and by "Reconnect Bluesky" on his page.
// The app password lives in memory only and is cleared once used. The parent can call
// ref.current.connect() (setup's Finish connects first when the fields are filled in).
import { forwardRef, useImperativeHandle, useState } from 'react'
import { looksLikeAppPassword, signupApi, tidyBlueskyHandle } from '../../api'
import { errorText } from '../../copy'
import { Button, ErrorText, TextField } from '../../ui/controls'

const LINK = 'inline-flex min-h-touch-sm flex-wrap items-center gap-x-2 self-start font-bold text-rose underline underline-offset-4 hover:text-rose-dark hover:decoration-2'

/**
 * words = accountsCopy().bluesky. onDone({ status: 'saved', handle } | { status: 'locked' }).
 * `connectLabel` overrides the button text (e.g. "Reconnect Bluesky").
 */
export const BlueskyConnect = forwardRef(function BlueskyConnect({ words: B, elderId, token, onDone, disabled, connectLabel, idPrefix = 'bsky' }, ref) {
  const [handle, setHandle] = useState('')
  const [appPassword, setAppPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const handleId = `${idPrefix}-handle`
  const passwordId = `${idPrefix}-password`

  /** -> true when Bluesky is connected (or already was), false after showing why not. */
  async function connect() {
    setError('')
    const errs = {}
    if (!tidyBlueskyHandle(handle)) errs.handle = B.handleInvalid
    if (!looksLikeAppPassword(appPassword)) errs.password = B.passwordInvalid
    setFieldErrors(errs)
    if (errs.handle || errs.password) {
      document.getElementById(errs.handle ? handleId : passwordId)?.focus()
      return false
    }
    if (!elderId || !token) {
      setError(B.errors.not_found)
      return false
    }
    setBusy(true)
    try {
      const res = await signupApi.connectBluesky(elderId, token, handle.trim(), appPassword)
      if (res?.ok) {
        setAppPassword('')
        onDone({ status: 'saved', handle: res.handle || tidyBlueskyHandle(handle) })
        return true
      }
      if (res?.error === 'locked') {
        // A Bluesky account is already connected and working: nothing to change.
        setAppPassword('')
        onDone({ status: 'locked' })
        return true
      }
      setError(B.errors[res?.error] || B.errors.failed)
      return false
    } catch (err) {
      setError(err.code === 'NOT_FOUND' ? B.errors.not_found : errorText(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  useImperativeHandle(ref, () => ({ hasInput: () => Boolean(handle.trim() || appPassword), connect, clear: () => setAppPassword('') }))

  const onEnter = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault() // connect Bluesky, don't submit a surrounding form
    connect()
  }

  return (
    <div className="flex w-full flex-col gap-5">
      <p>{B.lead}</p>
      <div className="flex flex-col gap-3">
        <p className="font-bold">{B.howTitle}</p>
        <ol className="ml-7 flex list-decimal flex-col gap-2">
          {B.how.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noopener noreferrer" className={LINK}>
          {B.link}
          <span className="text-sm font-normal">{B.newTab}</span>
        </a>
      </div>
      <TextField
        id={handleId}
        label={B.handle}
        hint={B.handleHint}
        error={fieldErrors.handle}
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={handle}
        onChange={(e) => {
          setHandle(e.target.value)
          setFieldErrors((f) => ({ ...f, handle: '' }))
        }}
        onKeyDown={onEnter}
      />
      <div className="flex w-full flex-col gap-2">
        <TextField
          id={passwordId}
          label={B.password}
          hint={B.passwordHint}
          error={fieldErrors.password}
          type={showPassword ? 'text' : 'password'}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={appPassword}
          onChange={(e) => {
            setAppPassword(e.target.value)
            setFieldErrors((f) => ({ ...f, password: '' }))
          }}
          onKeyDown={onEnter}
        />
        <Button variant="link" small className="self-start" aria-pressed={showPassword} onClick={() => setShowPassword((s) => !s)}>
          {showPassword ? B.hide : B.show}
        </Button>
      </div>
      <p className="rounded-inset bg-sage-tint px-5 py-4 text-sm">{B.safety}</p>
      <p className="text-sm text-muted">{B.use}</p>
      <ErrorText id={`${idPrefix}-error`}>{error}</ErrorText>
      <Button variant="secondary" busy={busy} busyLabel={B.connecting} disabled={disabled} onClick={connect}>
        {connectLabel || B.connect}
      </Button>
    </div>
  )
})
