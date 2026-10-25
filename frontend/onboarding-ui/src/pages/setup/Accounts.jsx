// Step 6 (after Review saved the sign-up): his own accounts. Bluesky with a handle + app password
// (signup:connectBluesky), Threads and X with OAuth (OAuthConnect.jsx). All optional. Finish
// connects Bluesky first if its fields are filled in, then asks for the first call.
// The app password lives in memory only and is cleared once used.
import { useState } from 'react'
import { looksLikeAppPassword, signupApi, tidyBlueskyHandle } from '../../api'
import { errorText } from '../../copy'
import { accountsCopy } from '../../copy/accounts'
import { CheckMark, ProfileArt } from '../../art/setup'
import { Button, ErrorText, TextField } from '../../ui/controls'
import { OAuthConnect } from './OAuthConnect'
import { ART, StepCard } from './steps'

const LINK = 'inline-flex min-h-touch-sm flex-wrap items-center gap-x-2 self-start font-bold text-rose underline underline-offset-4 hover:text-rose-dark hover:decoration-2'

export default function AccountsStep({ data, set, words, headingRef, elderId, token, onFinish, beforeLeave }) {
  const A = accountsCopy()
  const B = A.bluesky
  const [handle, setHandle] = useState('')
  const [appPassword, setAppPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('') // 'bluesky' | 'finish'
  const bluesky = data.bluesky // { status: 'saved', handle } | { status: 'locked' } | undefined

  /** -> true when Bluesky is connected (or he's already set up), false after showing why not. */
  async function connectBluesky() {
    setError('')
    const errs = {}
    if (!tidyBlueskyHandle(handle)) errs.handle = B.handleInvalid
    if (!looksLikeAppPassword(appPassword)) errs.password = B.passwordInvalid
    setFieldErrors(errs)
    if (errs.handle || errs.password) {
      document.getElementById(errs.handle ? 'bsky-handle' : 'bsky-password')?.focus()
      return false
    }
    if (!elderId || !token) {
      setError(B.errors.not_found)
      return false
    }
    setBusy('bluesky')
    try {
      const res = await signupApi.connectBluesky(elderId, token, handle.trim(), appPassword)
      if (res?.ok) {
        setAppPassword('')
        set({ bluesky: { status: 'saved', handle: res.handle || tidyBlueskyHandle(handle) } })
        return true
      }
      if (res?.error === 'locked') {
        // He's already active: his accounts are set up with us, carry on.
        setAppPassword('')
        set({ bluesky: { status: 'locked' } })
        return true
      }
      setError(B.errors[res?.error] || B.errors.failed)
      return false
    } catch (err) {
      setError(err.code === 'NOT_FOUND' ? B.errors.not_found : errorText(err))
      return false
    } finally {
      setBusy('')
    }
  }

  async function finish(skip) {
    if (!skip && !bluesky && (handle.trim() || appPassword)) {
      if (!(await connectBluesky())) return
    }
    setAppPassword('')
    setBusy('finish')
    await onFinish() // never throws; moves on to Done
  }

  const onEnter = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault() // connect Bluesky, don't submit the whole form
    connectBluesky()
  }

  return (
    <StepCard
      step={6}
      art={<ProfileArt className={ART} />}
      title={A.title(data.who === 'helper', words.n)}
      headingRef={headingRef}
      onSubmit={() => finish(false)}
      nextLabel={A.finish}
      busy={busy === 'finish'}
      busyLabel={A.finishing}
      actions={
        <Button variant="link" small disabled={Boolean(busy)} onClick={() => finish(true)}>
          {A.skip}
        </Button>
      }
    >
      <p className="flex items-center gap-3 font-bold">
        <CheckMark className="h-8 w-8 flex-none" fill="#8FAE9B" />
        {A.saved}
      </p>
      <p>{A.lead(data.who === 'helper')}</p>

      <section aria-labelledby="bsky-title" className="flex w-full flex-col gap-5 border-t border-line pt-6">
        <h2 id="bsky-title" className="text-subhead">
          {B.title}
        </h2>
        {bluesky ? (
          <p aria-live="polite" className="flex items-center gap-3 rounded-inset bg-sage-tint px-5 py-4">
            <CheckMark className="h-8 w-8 flex-none" fill="#8FAE9B" />
            {bluesky.status === 'saved' ? B.connected(bluesky.handle) : B.locked}
          </p>
        ) : (
          <>
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
              id="bsky-handle"
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
                id="bsky-password"
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
            <ErrorText id="bsky-error">{error}</ErrorText>
            <Button variant="secondary" busy={busy === 'bluesky'} busyLabel={B.connecting} disabled={busy === 'finish'} onClick={connectBluesky}>
              {B.connect}
            </Button>
          </>
        )}
      </section>

      <section aria-labelledby="oauth-title" className="flex w-full flex-col gap-5 border-t border-line pb-2 pt-6">
        <h2 id="oauth-title" className="text-subhead">
          {A.oauth.title}
        </h2>
        <OAuthConnect words={A.oauth} elderId={elderId} token={token} beforeLeave={beforeLeave} />
      </section>
    </StepCard>
  )
}
