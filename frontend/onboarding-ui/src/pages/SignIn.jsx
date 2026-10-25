// Sign in (#/signin, design-mockups/login-c.html): welcome -> phone -> code -> done (-> #/setup, or
// straight to #/home if this device already set up that phone); welcome -> email -> emailSent -> #/setup.
// Both codes and links are mocks for now (api.js): any 6 digits work, 000000 is a wrong code.
import { useEffect, useRef, useState } from 'react'
import { emailSignIn, phoneVerification } from '../api'
import { errorText } from '../copy'
import { SIGNIN as S, showPhone } from '../copy/signin'
import { go } from '../lib/route'
import { clearSession, loadSession, saveSession } from '../lib/session'
import { COUNTRIES, digitsOf, formatNational, toE164 } from '../phone'
import { BackChevron, CheckMark, EmailSentArt, MailIcon, PhoneIcon, ReadingArt } from '../art/setup'
import { Footer, Header } from '../ui/Header'
import { Button, Card, ErrorText, SelectField, TextField, cx } from '../ui/controls'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const RESEND_AFTER = 30 // seconds
const TAG = 'tag'
const DEMO = 'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-inset border-2 border-dashed border-line px-4 py-3.5 text-sm'
const CODE_INPUT = '[&_input]:text-center [&_input]:text-[2rem] [&_input]:font-bold [&_input]:tabular-nums [&_input]:tracking-[0.4em]'
const focus = (id) => document.getElementById(id)?.focus()

export default function SignIn() {
  const [view, setView] = useState('welcome')
  const [busy, setBusy] = useState(null) // the action waiting: 'phone' | 'code' | 'resend' | 'email' | 'link'
  const [error, setError] = useState('') // the open screen's field error
  const [notice, setNotice] = useState({}) // after "send again": { ok } or { err }
  const [country, setCountry] = useState(COUNTRIES[0])
  const [national, setNational] = useState('')
  const [sentTo, setSentTo] = useState('') // E.164 the code went to
  const [code, setCode] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [email, setEmail] = useState('')
  const [sentEmail, setSentEmail] = useState('')
  const trail = useRef([])
  const heading = useRef(null)
  const shown = useRef(view)

  // A new screen: focus its h1 (not on first load).
  useEffect(() => {
    if (shown.current === view) return
    shown.current = view
    heading.current?.focus()
  }, [view])

  // "Send it again in 0:30" counts down only while the code screen is open.
  useEffect(() => {
    if (view !== 'code' || seconds <= 0) return undefined
    const t = setTimeout(() => setSeconds((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [view, seconds])

  function open(next) {
    setError('')
    setNotice({})
    setView(next)
  }
  function show(next) {
    trail.current.push(view)
    open(next)
  }
  const back = () => open(trail.current.pop() || 'welcome')

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

  /** One async action: busy while it runs, its error worded by errorText. */
  async function run(key, task, onError) {
    setBusy(key)
    try {
      await task()
    } catch (err) {
      console.error(`sign-in: ${key} failed`, err)
      onError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  function sendCode(e) {
    e.preventDefault()
    if (digitsOf(national).length < country.digits) return fieldError('phone', S.phone.tooShort(country.digits))
    const e164 = toE164(country, national)
    return run('phone', async () => {
      await phoneVerification.sendCode(e164)
      setSentTo(e164)
      setCode('')
      setSeconds(RESEND_AFTER)
      show('code')
    }, setError)
  }

  function verify(e) {
    e.preventDefault()
    if (code.length !== 6) return fieldError('code', S.code.incomplete)
    return run('code', async () => {
      await phoneVerification.verifyCode(sentTo, code)
      const before = loadSession()
      if (before.elderId && before.phone === sentTo) return go('/home') // already set up on this device
      clearSession() // someone else's sign-up must not carry over
      saveSession({ phone: sentTo })
      show('done')
    }, (text) => fieldError('code', text))
  }

  /** "Send it again": send, then say so (or why not) under the buttons. */
  const resend = (key, send, ok) =>
    run(key, async () => {
      setNotice({})
      await send()
      setNotice({ ok })
    }, (err) => setNotice({ err }))
  const resendCode = () =>
    resend('resend', async () => {
      await phoneVerification.sendCode(sentTo)
      setSeconds(RESEND_AFTER)
      focus('code')
    }, S.code.resent(showPhone(sentTo)))
  const resendLink = () => resend('link', () => emailSignIn.sendLink(sentEmail), S.emailSent.resent(sentEmail))

  function sendLink(e) {
    e.preventDefault()
    const value = email.trim()
    if (!EMAIL_RE.test(value)) return fieldError('email', S.email.invalid)
    return run('email', async () => {
      await emailSignIn.sendLink(value)
      setSentEmail(value)
      show('emailSent')
    }, setError)
  }

  // "I clicked the link" stands in for real email links. A new sign-in: nothing from before carries over.
  function emailDone() {
    clearSession()
    go('/setup')
  }

  const title = (text) => <h1 ref={heading} tabIndex={-1} className="text-title">{text}</h1>
  const notices = (
    <>
      <p role="status" className="rounded-inset bg-sage-tint px-5 py-3.5 text-sm empty:hidden">{notice.ok}</p>
      <ErrorText>{notice.err}</ErrorText>
    </>
  )
  const submit = (key, label, busyLabel = S.sending) => (
    <Button type="submit" className="w-full" busy={busy === key} busyLabel={busyLabel}>{label}</Button>
  )

  return (
    <>
      <Header />
      <main id="main" className="py-8 sm:py-20">
        <div className="mx-auto grid max-w-[70rem] justify-items-center gap-6 px-5 sm:px-12 min-[960px]:grid-cols-[minmax(0,1fr)_minmax(0,36rem)] min-[960px]:items-center min-[960px]:gap-16">
          <div className={cx('w-full max-w-[11rem] min-[960px]:max-w-[28rem]', view !== 'welcome' && 'max-[959px]:hidden')}>
            <ReadingArt className="h-auto w-full" label={S.art} />
          </div>

          <Card className="w-full max-w-[36rem] shadow-card">
            <Button variant="link" small className="-mt-2" href={view === 'welcome' ? '#/' : undefined} onClick={view === 'welcome' ? undefined : back}>
              <BackChevron />
              {view === 'welcome' ? S.backHome : S.back}
            </Button>

            <section key={view} className="flex w-full flex-col gap-6 motion-safe:animate-rise">
              {view === 'welcome' && (
                <>
                  {title(S.welcome.title)}
                  <p>{S.welcome.lead}</p>
                  <div className="flex flex-col gap-4">
                    <Button className="w-full" onClick={() => show('phone')}>
                      <PhoneIcon />
                      {S.welcome.phone}
                    </Button>
                    <p className="flex items-center gap-4 text-sm font-bold before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
                      {S.welcome.or}
                    </p>
                    <Button variant="secondary" className="w-full" onClick={() => show('email')}>
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
                  <form noValidate onSubmit={sendCode} className="flex flex-col gap-6">
                    <SelectField id="country" label={S.phone.country} autoComplete="tel-country-code" value={country.code} onChange={(e) => changeCountry(e.target.value)}>
                      {COUNTRIES.map((c) => (
                        <option key={c.code} value={c.code}>{`${c.name} (${c.dial})`}</option>
                      ))}
                    </SelectField>
                    <TextField
                      id="phone" label={S.phone.label} hint={S.phone.hint} error={error} type="tel" inputMode="tel" autoComplete="tel-national"
                      placeholder={country.example} value={national} onChange={typing(setNational, (v) => formatNational(country, v))}
                    />
                    {submit('phone', S.phone.submit)}
                  </form>
                </>
              )}

              {view === 'code' && (
                <>
                  {title(S.code.title)}
                  <p>
                    {S.code.sentTo} <strong className="[overflow-wrap:anywhere]">{showPhone(sentTo)}</strong>.{' '}
                    <Button variant="link" small onClick={back}>{S.code.change}</Button>
                  </p>
                  <form noValidate onSubmit={verify} className="flex flex-col gap-6">
                    <TextField
                      id="code" label={S.code.label} hint={S.code.hint} error={error} type="text" inputMode="numeric" autoComplete="one-time-code"
                      maxLength={6} value={code} onChange={typing(setCode, (v) => v.replace(/\D/g, '').slice(0, 6))}
                      className={cx('max-w-[21rem]', CODE_INPUT)}
                    />
                    {submit('code', S.code.submit, S.checking)}
                  </form>
                  {seconds > 0 ? (
                    <p>
                      {S.code.wait} <span className="tabular-nums">0:{String(seconds).padStart(2, '0')}</span>.
                    </p>
                  ) : (
                    <Button variant="link" small className="self-start" onClick={resendCode} busy={busy === 'resend'} busyLabel={S.sending}>
                      {S.code.resend}
                    </Button>
                  )}
                  {notices}
                  <p className={DEMO}>
                    <span className={TAG}>{S.demo}</span> {S.code.demo}
                  </p>
                </>
              )}

              {view === 'email' && (
                <>
                  {title(S.email.title)}
                  <p>{S.email.lead}</p>
                  <form noValidate onSubmit={sendLink} className="flex flex-col gap-6">
                    <TextField
                      id="email" label={S.email.label} error={error} type="email" inputMode="email" autoComplete="email" spellCheck={false}
                      placeholder="name@example.com" value={email} onChange={typing(setEmail)}
                    />
                    {submit('email', S.email.submit)}
                  </form>
                </>
              )}

              {view === 'emailSent' && (
                <>
                  <EmailSentArt className="w-full max-w-[13rem]" />
                  {title(S.emailSent.title)}
                  <p>
                    {S.emailSent.sentTo} <strong className="[overflow-wrap:anywhere]">{sentEmail}</strong>.
                  </p>
                  <p>{S.emailSent.lead}</p>
                  <div className="flex flex-col items-start">
                    <Button variant="link" small onClick={resendLink} busy={busy === 'link'} busyLabel={S.sending}>{S.emailSent.resend}</Button>
                    <Button variant="link" small onClick={back}>{S.emailSent.different}</Button>
                  </div>
                  {notices}
                  <div className={DEMO}>
                    <span className={TAG}>{S.demo}</span> {S.emailSent.demo}
                    <Button variant="secondary" className="mt-1 w-full" onClick={emailDone}>{S.emailSent.clicked}</Button>
                  </div>
                </>
              )}

              {view === 'done' && (
                <>
                  <CheckMark className="h-20 w-20" fill="#8FAE9B" />
                  {title(S.done.title)}
                  <p className="text-lg">{S.done.lead}</p>
                  <Button className="w-full" onClick={() => go('/setup')}>{S.done.next}</Button>
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
