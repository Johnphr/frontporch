// Sign in (#/signin): welcome -> phone -> straight to #/home if this device already set up (or
// signed in to) that phone, even after signing out (lib/session.js knownSignup); otherwise the
// family code (signup:signIn gives a new token) -> #/home. From the code screen: "Sign up" goes
// to #/setup for a new number, and "Start over" (signup:startOver, behind the code, confirmed
// first) archives the number's setup and starts setup fresh. welcome -> email -> #/setup.
import { useEffect, useRef, useState } from 'react'
import { coded, signupApi } from '../api'
import { errorText } from '../copy'
import { SIGNIN as S, SIGNIN_BY_LANG, showPhone } from '../copy/signin'
import { go } from '../lib/route'
import { clearSession, forgetPhone, knownSignup, loadSession, saveSession } from '../lib/session'
import { COUNTRIES, digitsOf, formatNational, toE164 } from '../phone'
import { BackChevron, MailIcon, PhoneIcon, ReadingArt } from '../art/setup'
import { Footer, Header } from '../ui/Header'
import { Button, Card, ErrorText, SelectField, TextField, cx } from '../ui/controls'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_LENGTH = 6
const focus = (id) => document.getElementById(id)?.focus()
const C = SIGNIN_BY_LANG.en.code
const O = SIGNIN_BY_LANG.en.startOver

// signIn / startOver's refusal -> an ERRORS code (copy.js)
const REFUSED = { wrong_code: 'WRONG_CODE', too_many_tries: 'TOO_MANY_TRIES' }

export default function SignIn() {
  const [view, setView] = useState('welcome') // welcome | phone | code | startOver | email
  const [error, setError] = useState('') // the open screen's field error
  const [country, setCountry] = useState(COUNTRIES[0])
  const [national, setNational] = useState('')
  const [phone, setPhone] = useState('') // E.164, once the phone screen accepted it
  const [code, setCode] = useState('') // digits only
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')
  const heading = useRef(null)
  const shown = useRef(view)

  // A new screen: focus its h1 (not on first load).
  useEffect(() => {
    if (shown.current === view) return
    shown.current = view
    heading.current?.focus()
  }, [view])

  function open(next) {
    setError('')
    setView(next)
  }

  /** onChange for a field: store the (cleaned) value and clear its error. */
  const typing = (setter, clean = (v) => v) => (e) => {
    setter(clean(e.target.value))
    setError('')
  }
  function changeCountry(id) {
    const next = COUNTRIES.find((c) => c.code === id)
    setCountry(next)
    setNational(formatNational(next, national))
    setError('')
  }
  /** Show a field error and put the cursor back in that field. */
  function fieldError(id, text) {
    setError(text)
    focus(id)
  }

  function continuePhone(e) {
    e.preventDefault()
    if (digitsOf(national).length < country.digits) return fieldError('phone', S.phone.tooShort(country.digits))
    const e164 = toE164(country, national)
    const before = loadSession()
    if (before.elderId && before.token && before.phone === e164) return go('/home') // already set up on this device
    clearSession() // someone else's sign-up must not carry over (it stays a known device)
    const known = knownSignup(e164)
    if (known) {
      saveSession(known) // this device set up that phone before: his token comes back
      return go('/home')
    }
    setPhone(e164)
    setCode('')
    return open('code')
  }

  /** The typed code when it's complete, else null after saying so. */
  function readCode() {
    if (code.length === CODE_LENGTH) return code
    fieldError('code', C.incomplete)
    return null
  }

  async function continueCode(e) {
    e.preventDefault()
    const typed = readCode()
    if (!typed) return
    setBusy(true)
    try {
      const res = await signupApi.signIn(phone, typed)
      if (!res?.ok) return fieldError('code', errorText(coded(REFUSED[res?.reason] || 'SERVER')))
      saveSession({ phone, elderId: res.elderId, token: res.token, familyCode: typed })
      go('/home')
    } catch (err) {
      console.error('signIn failed', err.code || 'error')
      fieldError('code', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  /** A new number: setup, with the phone already filled in. */
  function signUp() {
    saveSession({ phone })
    go('/setup')
  }

  function askStartOver() {
    if (!readCode()) return
    open('startOver')
  }

  async function startOver() {
    setBusy(true)
    setError('')
    try {
      const res = await signupApi.startOver(phone, code)
      if (!res?.ok) {
        const text = errorText(coded(REFUSED[res?.reason] || 'SERVER'))
        if (res?.reason === 'wrong_code') {
          open('code')
          return fieldError('code', text)
        }
        return setError(text)
      }
      forgetPhone(phone) // whatever this device kept for the number is gone on the backend too
      saveSession({ phone })
      go('/setup')
    } catch (err) {
      console.error('startOver failed', err.code || 'error')
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  function continueEmail(e) {
    e.preventDefault()
    if (!EMAIL_RE.test(email.trim())) return fieldError('email', S.email.invalid)
    clearSession() // a new sign-in: nothing from before carries over; setup asks for the phone
    return go('/setup')
  }

  const title = (text) => <h1 ref={heading} tabIndex={-1} className="text-title">{text}</h1>
  const submit = (label, extra) => <Button type="submit" className="w-full" {...extra}>{label}</Button>
  const backTo = view === 'welcome' ? null : view === 'code' ? 'phone' : view === 'startOver' ? 'code' : 'welcome'

  return (
    <>
      <Header />
      <main id="main" className="py-8 sm:py-20">
        <div className="mx-auto grid max-w-[70rem] justify-items-center gap-6 px-5 sm:px-12 min-[960px]:grid-cols-[minmax(0,1fr)_minmax(0,36rem)] min-[960px]:items-center min-[960px]:gap-16">
          <div className={cx('w-full max-w-[11rem] min-[960px]:max-w-[28rem]', view !== 'welcome' && 'max-[959px]:hidden')}>
            <ReadingArt className="h-auto w-full" label={S.art} />
          </div>

          <Card className="w-full max-w-[36rem] shadow-card">
            <Button variant="link" small className="-mt-2" href={backTo ? undefined : '#/'} onClick={backTo ? () => open(backTo) : undefined} disabled={busy}>
              <BackChevron />
              {backTo ? S.back : S.backHome}
            </Button>

            <section key={view} className={cx('flex w-full flex-col gap-6', view === 'welcome' ? 'motion-safe:animate-rise-back' : 'motion-safe:animate-rise')}>
              {view === 'welcome' && (
                <>
                  {title(S.welcome.title)}
                  <p>{S.welcome.lead}</p>
                  <div className="flex flex-col gap-4">
                    <Button className="w-full" onClick={() => open('phone')}>
                      <PhoneIcon />
                      {S.welcome.phone}
                    </Button>
                    <p className="flex items-center gap-4 text-sm font-bold before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
                      {S.welcome.or}
                    </p>
                    <Button variant="secondary" className="w-full" onClick={() => open('email')}>
                      <MailIcon />
                      {S.welcome.email}
                    </Button>
                  </div>
                  <p className="text-sm">
                    <strong>{S.welcome.newHere}</strong> {S.welcome.newHereRest}
                  </p>
                </>
              )}

              {view === 'phone' && (
                <>
                  {title(S.phone.title)}
                  <p>{S.phone.lead}</p>
                  <form noValidate onSubmit={continuePhone} className="flex flex-col gap-6">
                    <SelectField id="country" label={S.phone.country} autoComplete="tel-country-code" value={country.code} onChange={(e) => changeCountry(e.target.value)}>
                      {COUNTRIES.map((c) => (
                        <option key={c.code} value={c.code}>{`${c.name} (${c.dial})`}</option>
                      ))}
                    </SelectField>
                    <TextField
                      id="phone" label={S.phone.label} error={error} type="tel" inputMode="tel" autoComplete="tel-national"
                      placeholder={country.example} value={national} onChange={typing(setNational, (v) => formatNational(country, v))}
                    />
                    {submit(S.phone.submit)}
                  </form>
                </>
              )}

              {view === 'code' && (
                <>
                  {title(C.title)}
                  <p>{C.lead(showPhone(phone))}</p>
                  <form noValidate onSubmit={continueCode} className="flex flex-col gap-6">
                    <TextField
                      id="code" label={C.label} hint={C.hint} error={error} type="text" inputMode="numeric" autoComplete="one-time-code"
                      pattern="[0-9]*" maxLength={CODE_LENGTH} spellCheck={false} placeholder="000000" value={code}
                      onChange={typing(setCode, (v) => digitsOf(v).slice(0, CODE_LENGTH))}
                      style={{ fontSize: '2rem', letterSpacing: '0.4em', fontVariantNumeric: 'tabular-nums' }}
                    />
                    {submit(C.submit, { busy, busyLabel: C.busy })}
                  </form>
                  <div className="flex flex-col gap-4 border-t border-line pt-6">
                    <p className="text-sm">
                      <strong>{C.newHere}</strong>
                    </p>
                    <Button variant="secondary" className="w-full" onClick={signUp} disabled={busy}>
                      {C.signUp}
                    </Button>
                    <Button variant="link" small className="self-start" onClick={askStartOver} disabled={busy}>
                      {C.startOver}
                    </Button>
                  </div>
                </>
              )}

              {view === 'startOver' && (
                <div role="alertdialog" aria-labelledby="start-over-title" aria-describedby="start-over-lead" className="flex flex-col gap-6">
                  <h1 id="start-over-title" ref={heading} tabIndex={-1} className="text-title">{O.title}</h1>
                  <p id="start-over-lead">{O.lead}</p>
                  <p className="rounded-inset bg-wash px-5 py-4 font-bold">{showPhone(phone)}</p>
                  <ErrorText>{error}</ErrorText>
                  <div className="flex flex-col gap-4">
                    <Button className="w-full" busy={busy} busyLabel={O.busy} onClick={startOver}>
                      {O.confirm}
                    </Button>
                    <Button variant="link" small className="self-start" onClick={() => open('code')} disabled={busy}>
                      {O.cancel}
                    </Button>
                  </div>
                </div>
              )}

              {view === 'email' && (
                <>
                  {title(S.email.title)}
                  <p>{S.email.lead}</p>
                  <form noValidate onSubmit={continueEmail} className="flex flex-col gap-6">
                    <TextField
                      id="email" label={S.email.label} error={error} type="email" inputMode="email" autoComplete="email" spellCheck={false}
                      placeholder="name@example.com" value={email} onChange={typing(setEmail)}
                    />
                    {submit(S.email.submit)}
                  </form>
                </>
              )}
            </section>
          </Card>
        </div>
      </main>
      <Footer />
    </>
  )
}
