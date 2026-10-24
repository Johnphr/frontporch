import { useEffect, useRef, useState } from 'react'
import { authApi } from './api'
import { COUNTRIES, STRINGS } from './i18n'
import { digitsOf, formatNational, toE164 } from './phone'
import {
  BackButton,
  Button,
  ErrorBanner,
  GoogleIcon,
  LangToggle,
  LinkedInIcon,
  Note,
  PasswordField,
  SelectField,
  StepHeader,
  TalaveraBand,
  TextField,
} from './ui'
import { BigMarigold, Scene, SvgDefs } from './Scene'

const KEY = 'onboarding-v1'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const COOLDOWN = 30

// Progress survives a refresh. The password and the SMS code are never stored.
const load = () => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY)) || {}
  } catch {
    return {}
  }
}
const save = (state) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* storage unavailable: the flow still works */
  }
}

export default function App() {
  const saved = useRef(load()).current
  const [lang, setLang] = useState(saved.lang || 'es')
  const [step, setStep] = useState(saved.step || 1) // 1 | 2 | 3 | 'done'
  const [phoneStage, setPhoneStage] = useState(saved.phoneStage || 'number')
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState(saved.email || '')
  const [password, setPassword] = useState('')
  const [countryCode, setCountryCode] = useState(saved.countryCode || 'MX')
  const [phone, setPhone] = useState(saved.phone || '')
  const [code, setCode] = useState('')
  const [resendsLeft, setResendsLeft] = useState(saved.resendsLeft ?? 3)
  const [cooldown, setCooldown] = useState(0)
  const [linkedin, setLinkedin] = useState(saved.linkedin || null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})

  const t = STRINGS[lang]
  const country = COUNTRIES.find((c) => c.code === countryCode)
  const headingRef = useRef(null)
  const firstRender = useRef(true)

  useEffect(() => {
    save({ lang, step, phoneStage, email, countryCode, phone, resendsLeft, linkedin })
    document.documentElement.lang = t.htmlLang
  }, [lang, step, phoneStage, email, countryCode, phone, resendsLeft, linkedin, t.htmlLang])

  // Move focus to the new heading whenever the screen changes.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    headingRef.current?.focus()
  }, [step, phoneStage, mode])

  useEffect(() => {
    if (cooldown <= 0) return undefined
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => clearTimeout(id)
  }, [cooldown])

  const clearMessages = () => {
    setError('')
    setFieldErrors({})
  }

  async function run(task) {
    setBusy(true)
    setError('')
    try {
      await task()
      return true
    } catch (e) {
      setError(t.errors[e.code] || t.errors.NETWORK)
      return false
    } finally {
      setBusy(false)
    }
  }

  /* ----- step 1 ----- */
  async function onGoogle() {
    clearMessages()
    if (await run(() => authApi.signInWithGoogle())) setStep(2)
  }

  async function onAccount(e) {
    e.preventDefault()
    const errs = {}
    if (!EMAIL_RE.test(email.trim())) errs.email = t.s1.emailInvalid
    if (password.length < 8) errs.password = t.s1.passwordShort
    setFieldErrors(errs)
    setError('')
    if (Object.keys(errs).length) return
    if (await run(() => authApi.signInWithEmail(email.trim(), password, mode))) {
      setPassword('')
      setStep(2)
    }
  }

  /* ----- step 2 ----- */
  async function onPhone(e) {
    e.preventDefault()
    setError('')
    if (digitsOf(phone).length !== country.digits) {
      setFieldErrors({ phone: t.s2.phoneInvalid(country.digits) })
      return
    }
    setFieldErrors({})
    if (await run(() => authApi.sendCode(toE164(country, phone)))) {
      setCode('')
      setCooldown(COOLDOWN)
      setPhoneStage('code')
    }
  }

  async function onVerify(e) {
    e.preventDefault()
    setError('')
    if (code.length !== 6) {
      setFieldErrors({ code: t.s2.codeInvalid })
      return
    }
    setFieldErrors({})
    if (await run(() => authApi.verifyCode(toE164(country, phone), code))) setStep(3)
  }

  async function onResend() {
    if (resendsLeft <= 0 || cooldown > 0) return
    clearMessages()
    if (await run(() => authApi.sendCode(toE164(country, phone)))) {
      setResendsLeft((n) => n - 1)
      setCooldown(COOLDOWN)
      setCode('')
    }
  }

  /* ----- step 3 ----- */
  async function onLinkedIn() {
    clearMessages()
    if (await run(() => authApi.connectLinkedIn())) {
      setLinkedin('connected')
      setStep('done')
    }
  }

  function onSkip() {
    clearMessages()
    setLinkedin('skipped')
    setStep('done')
  }

  function goBack() {
    clearMessages()
    if (step === 3) setStep(2)
    else if (step === 2 && phoneStage === 'code') setPhoneStage('number')
    else if (step === 2) setStep(1)
  }

  const heading = 'font-display text-3xl font-bold text-tinta-900 md:text-[2.5rem] md:leading-[1.1]'

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-lino-50 md:flex-row">
      <SvgDefs />
      <aside className="md:sticky md:top-0 md:h-screen md:w-[42%] md:max-w-[560px] md:shrink-0">
        <Scene compact step={step === 'done' ? 4 : step} />
        <Scene step={step === 'done' ? 4 : step} />
      </aside>
      <TalaveraBand position="bottom" className="md:hidden" />
      <TalaveraBand position="side" className="hidden md:block" />

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-6 py-8 md:justify-center md:px-12 md:py-10">
        <div className="flex flex-col gap-6">
        <div className="flex justify-end">
          <LangToggle
            label={t.langName}
            ariaLabel={t.langAria}
            onClick={() => {
              setLang(lang === 'es' ? 'en' : 'es')
            }}
          />
        </div>

        {step !== 'done' && <StepHeader step={step} label={t.stepOf(step)} title={t.stepTitles[step - 1]} />}

        {/* key restarts the gentle fade each time the screen changes */}
        <div key={`${step}-${phoneStage}-${mode}`} className="flex flex-1 flex-col gap-6 motion-safe:animate-rise">
          {step !== 1 && step !== 'done' && <BackButton onClick={goBack}>{t.back}</BackButton>}

          {/* ---------- Screen 1: sign in / register ---------- */}
          {step === 1 && (
            <>
              <header className="flex flex-col gap-3">
                <h1 ref={headingRef} tabIndex={-1} className={heading}>
                  {mode === 'signin' ? t.s1.titleIn : t.s1.titleReg}
                </h1>
                <p>{mode === 'signin' ? t.s1.leadIn : t.s1.leadReg}</p>
              </header>

              <Button variant="secondary" icon={<GoogleIcon />} onClick={onGoogle} disabled={busy}>
                {t.s1.google}
              </Button>

              <div className="flex items-center gap-4 text-lg text-tinta-700" role="separator">
                <span aria-hidden="true" className="h-0.5 flex-1 bg-lino-300" />
                <span>{t.s1.or}</span>
                <span aria-hidden="true" className="h-0.5 flex-1 bg-lino-300" />
              </div>

              <form noValidate onSubmit={onAccount} className="flex flex-col gap-5">
                <TextField
                  id="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  label={t.s1.email}
                  hint={t.s1.emailHint}
                  error={fieldErrors.email}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <PasswordField
                  id="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  label={t.s1.password}
                  hint={mode === 'register' ? t.s1.passwordHint : undefined}
                  error={fieldErrors.password}
                  labels={t.s1}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <ErrorBanner>{error}</ErrorBanner>
                <Button type="submit" disabled={busy}>
                  {busy ? t.working : mode === 'signin' ? t.s1.submitIn : t.s1.submitReg}
                </Button>
              </form>

              <Button
                variant="quiet"
                onClick={() => {
                  clearMessages()
                  setMode(mode === 'signin' ? 'register' : 'signin')
                }}
              >
                {mode === 'signin' ? t.s1.toReg : t.s1.toIn}
              </Button>
            </>
          )}

          {/* ---------- Screen 2: phone, number then code ---------- */}
          {step === 2 && phoneStage === 'number' && (
            <>
              <header className="flex flex-col gap-3">
                <h1 ref={headingRef} tabIndex={-1} className={heading}>
                  {t.s2.title}
                </h1>
                <p>{t.s2.lead}</p>
              </header>
              <form noValidate onSubmit={onPhone} className="flex flex-1 flex-col gap-5">
                <SelectField
                  id="country"
                  label={t.s2.country}
                  value={countryCode}
                  onChange={(e) => {
                    setCountryCode(e.target.value)
                    setPhone('')
                    setFieldErrors({})
                  }}
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.names[lang]} ({c.dial})
                    </option>
                  ))}
                </SelectField>
                <TextField
                  id="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  label={t.s2.phone}
                  error={fieldErrors.phone}
                  placeholder={formatNational(country, '5512345678')}
                  value={phone}
                  onChange={(e) => setPhone(formatNational(country, e.target.value))}
                />
                <Note>{t.s2.privacy}</Note>
                <ErrorBanner>{error}</ErrorBanner>
                <div className="flex-1" />
                <Button type="submit" disabled={busy}>
                  {busy ? t.working : t.s2.continue}
                </Button>
              </form>
            </>
          )}

          {step === 2 && phoneStage === 'code' && (
            <>
              <header className="flex flex-col gap-3">
                <h1 ref={headingRef} tabIndex={-1} className={heading}>
                  {t.s2.codeTitle}
                </h1>
                <p>{t.s2.codeLead(`${country.dial} ${phone}`)}</p>
              </header>
              <form noValidate onSubmit={onVerify} className="flex flex-1 flex-col gap-5">
                <TextField
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  label={t.s2.code}
                  error={fieldErrors.code}
                  placeholder="000 000"
                  className="text-center text-3xl tracking-[0.3em]"
                  value={code}
                  onChange={(e) => setCode(digitsOf(e.target.value).slice(0, 6))}
                />
                <ErrorBanner>{error}</ErrorBanner>
                <Button type="submit" disabled={busy}>
                  {busy ? t.working : t.s2.verify}
                </Button>
                <div className="flex flex-col gap-3" aria-live="polite">
                  <Button
                    variant="secondary"
                    onClick={onResend}
                    disabled={busy || cooldown > 0 || resendsLeft <= 0}
                  >
                    {t.s2.resend}
                  </Button>
                  <p className="text-lg text-tinta-700">
                    {resendsLeft <= 0
                      ? t.s2.noResends
                      : `${cooldown > 0 ? t.s2.resendIn(cooldown) + ' ' : ''}${t.s2.resendsLeft(resendsLeft)}`}
                  </p>
                </div>
                <Button
                  variant="quiet"
                  onClick={() => {
                    clearMessages()
                    setPhoneStage('number')
                  }}
                >
                  {t.s2.changeNumber}
                </Button>
              </form>
            </>
          )}

          {/* ---------- Screen 3: LinkedIn ---------- */}
          {step === 3 && (
            <>
              <header className="flex flex-col gap-3">
                <h1 ref={headingRef} tabIndex={-1} className={heading}>
                  {t.s3.title}
                </h1>
                <p>{t.s3.lead}</p>
              </header>
              <div className="flex-1" />
              <ErrorBanner>{error}</ErrorBanner>
              <div className="flex flex-col gap-4">
                <Button icon={<LinkedInIcon />} onClick={onLinkedIn} disabled={busy}>
                  {busy ? t.working : t.s3.connect}
                </Button>
                <Button variant="secondary" onClick={onSkip} disabled={busy}>
                  {t.s3.skip}
                </Button>
              </div>
            </>
          )}

          {/* ---------- Done ---------- */}
          {step === 'done' && (
            <>
              <BigMarigold className="h-24 w-24 self-center" />
              <header className="flex flex-col gap-3">
                <h1 ref={headingRef} tabIndex={-1} className={heading}>
                  {t.done.title}
                </h1>
                <p>{t.done.lead}</p>
              </header>
              <Note>{linkedin === 'connected' ? t.done.linkedinYes : t.done.linkedinNo}</Note>
              <div className="flex-1" />
              <Button onClick={() => window.alert('→ app')}>{t.done.go}</Button>
            </>
          )}
        </div>
        </div>
      </main>
    </div>
  )
}
