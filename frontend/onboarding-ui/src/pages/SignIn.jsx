// Sign in (#/signin): welcome -> phone -> #/setup (or straight to #/home if this device already set
// up that phone, even after signing out: lib/session.js knownSignup); welcome -> email -> #/setup.
// No codes or links: the backend has no SMS or email sign-in yet, so the device just remembers
// the phone and the sign-up it made for it.
import { useEffect, useRef, useState } from 'react'
import { SIGNIN as S } from '../copy/signin'
import { go } from '../lib/route'
import { clearSession, knownSignup, loadSession, saveSession } from '../lib/session'
import { COUNTRIES, digitsOf, formatNational, toE164 } from '../phone'
import { BackChevron, MailIcon, PhoneIcon, ReadingArt } from '../art/setup'
import { Footer, Header } from '../ui/Header'
import { Button, Card, SelectField, TextField, cx } from '../ui/controls'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const focus = (id) => document.getElementById(id)?.focus()

export default function SignIn() {
  const [view, setView] = useState('welcome') // welcome | phone | email
  const [error, setError] = useState('') // the open screen's field error
  const [country, setCountry] = useState(COUNTRIES[0])
  const [national, setNational] = useState('')
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
    saveSession({ phone: e164 })
    return go('/setup')
  }

  function continueEmail(e) {
    e.preventDefault()
    if (!EMAIL_RE.test(email.trim())) return fieldError('email', S.email.invalid)
    clearSession() // a new sign-in: nothing from before carries over; setup asks for the phone
    return go('/setup')
  }

  const title = (text) => <h1 ref={heading} tabIndex={-1} className="text-title">{text}</h1>
  const submit = (label) => <Button type="submit" className="w-full">{label}</Button>

  return (
    <>
      <Header />
      <main id="main" className="py-8 sm:py-20">
        <div className="mx-auto grid max-w-[70rem] justify-items-center gap-6 px-5 sm:px-12 min-[960px]:grid-cols-[minmax(0,1fr)_minmax(0,36rem)] min-[960px]:items-center min-[960px]:gap-16">
          <div className={cx('w-full max-w-[11rem] min-[960px]:max-w-[28rem]', view !== 'welcome' && 'max-[959px]:hidden')}>
            <ReadingArt className="h-auto w-full" label={S.art} />
          </div>

          <Card className="w-full max-w-[36rem] shadow-card">
            <Button variant="link" small className="-mt-2" href={view === 'welcome' ? '#/' : undefined} onClick={view === 'welcome' ? undefined : () => open('welcome')}>
              <BackChevron />
              {view === 'welcome' ? S.backHome : S.back}
            </Button>

            <section key={view} className="flex w-full flex-col gap-6 motion-safe:animate-rise">
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
