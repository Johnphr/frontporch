import { useEffect, useRef, useState } from 'react'
import { isConfigured, looksLikeLinkedInProfile, phoneVerification, signupApi } from './api'
import { COUNTRIES, STRINGS } from './i18n'
import { digitsOf, formatNational, toE164 } from './phone'
import {
  BackButton,
  Button,
  ErrorBanner,
  LangToggle,
  LinkedInIcon,
  Note,
  RadioCards,
  SelectField,
  StepHeader,
  TalaveraBand,
  TextField,
} from './ui'
import { DoneStep } from './DoneStep'
import { Scene, SvgDefs } from './Scene'

// Flow (convex/signup.ts): 1 name + language -> 2 phone (register) -> 3 character (setCharacter)
// -> 4 LinkedIn, optional (setLinkedin) -> done: "Call me now" (requestCall) + call status (DoneStep.jsx).
//
// The backend has no SMS verification yet, so the 6-digit code screen is skipped. Turn this on
// (and replace phoneVerification in api.js with a real provider) once it exists.
const VERIFY_PHONE = false

const TOTAL_STEPS = 4
const KEY = 'onboarding-v2'
const COOLDOWN = 30
const MAX_NAME = 100

// Progress survives a refresh. The SMS code and the LinkedIn link are never stored.
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
const clearSaved = () => {
  try {
    sessionStorage.removeItem(KEY)
    sessionStorage.removeItem('onboarding-v2-call') // DoneStep's call
  } catch {
    /* ignore */
  }
}

export default function App() {
  return isConfigured ? <Onboarding /> : <SetupNeeded />
}

/** Shown when the site was built without VITE_CONVEX_URL, instead of a broken form. */
function SetupNeeded() {
  const [lang, setLang] = useState('es')
  const t = STRINGS[lang]
  return (
    <Shell t={t} sceneStep={1} onToggle={() => setLang(lang === 'es' ? 'en' : 'es')}>
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-3xl font-bold text-tinta-900 md:text-[2.5rem] md:leading-[1.1]">{t.setup.title}</h1>
        <p>{t.setup.lead}</p>
      </header>
    </Shell>
  )
}

function Shell({ t, sceneStep, onToggle, children }) {
  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-lino-50 md:flex-row">
      <SvgDefs />
      <aside className="md:sticky md:top-0 md:h-screen md:w-[42%] md:max-w-[560px] md:shrink-0">
        <Scene compact step={sceneStep} />
        <Scene step={sceneStep} />
      </aside>
      <TalaveraBand position="bottom" className="md:hidden" />
      <TalaveraBand position="side" className="hidden md:block" />
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-6 py-8 md:justify-center md:px-12 md:py-10">
        <div className="flex flex-col gap-6">
          <div className="flex justify-end">
            <LangToggle label={t.langName} ariaLabel={t.langAria} onClick={onToggle} />
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}

function Onboarding() {
  const saved = useRef(load()).current
  const [lang, setLang] = useState(saved.lang || 'es')
  const [langPinned, setLangPinned] = useState(Boolean(saved.langPinned)) // user used the toggle
  const [step, setStep] = useState(saved.step || 1) // 1 | 2 | 3 | 4 | 'done'
  const [phoneStage, setPhoneStage] = useState(saved.phoneStage || 'number')
  const [name, setName] = useState(saved.name || '')
  const [callLang, setCallLang] = useState(saved.callLang || saved.lang || 'es')
  const [countryCode, setCountryCode] = useState(saved.countryCode || 'MX')
  const [phone, setPhone] = useState(saved.phone || '')
  const [code, setCode] = useState('')
  const [resendsLeft, setResendsLeft] = useState(saved.resendsLeft ?? 3)
  const [cooldown, setCooldown] = useState(0)
  const [elderId, setElderId] = useState(saved.elderId || null)
  const [characters, setCharacters] = useState(null) // null = not loaded
  const [charsFailed, setCharsFailed] = useState(false)
  const [characterId, setCharacterId] = useState(saved.characterId || '')
  const [characterName, setCharacterName] = useState(saved.characterName || '')
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [linkedin, setLinkedin] = useState(saved.linkedin || null) // 'saved' | 'skipped' | null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null) // { code, message }
  const [fieldErrors, setFieldErrors] = useState({})

  const t = STRINGS[lang]
  const country = COUNTRIES.find((c) => c.code === countryCode)
  const headingRef = useRef(null)
  const firstRender = useRef(true)

  useEffect(() => {
    save({
      lang, langPinned, step, phoneStage, name, callLang, countryCode, phone, resendsLeft,
      elderId, characterId, characterName, linkedin,
    })
    document.documentElement.lang = t.htmlLang
  }, [lang, langPinned, step, phoneStage, name, callLang, countryCode, phone, resendsLeft, elderId, characterId, characterName, linkedin, t.htmlLang])

  // Move focus to the new heading whenever the screen changes.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    headingRef.current?.focus()
  }, [step, phoneStage])

  useEffect(() => {
    if (cooldown <= 0) return undefined
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => clearTimeout(id)
  }, [cooldown])

  // Characters are loaded when the picker opens (and again after a failed load + retry).
  useEffect(() => {
    if (step !== 3 || characters || charsFailed) return
    let cancelled = false
    signupApi
      .listCharacters()
      .then((list) => {
        if (!cancelled) setCharacters(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (!cancelled) setCharsFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [step, characters, charsFailed])

  const clearMessages = () => {
    setError(null)
    setFieldErrors({})
  }

  // Backend text for errors we have no translation for; our own copy otherwise.
  const errorText = (e) => {
    if (!e) return ''
    if (e.code === 'SERVER' && e.message && e.message !== 'SERVER') return e.message
    return t.errors[e.code] || t.errors.SERVER
  }

  async function run(task) {
    setBusy(true)
    setError(null)
    try {
      if (step !== 1 && step !== 2 && !elderId) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
      await task()
      return true
    } catch (e) {
      setError({ code: e.code || 'SERVER', message: e.message })
      return false
    } finally {
      setBusy(false)
    }
  }

  function chooseCallLang(value) {
    setCallLang(value)
    if (!langPinned) setLang(value) // the call language also sets the page language
  }

  function startOver() {
    clearSaved()
    window.location.reload()
  }

  /* ----- step 1: name + language ----- */
  function onName(e) {
    e.preventDefault()
    const clean = name.replace(/\s+/g, ' ').trim()
    if (!clean || clean.length > MAX_NAME) {
      setFieldErrors({ name: t.s1.nameInvalid })
      return
    }
    clearMessages()
    setName(clean)
    setStep(2)
  }

  /* ----- step 2: phone ----- */
  const register = () =>
    run(async () => {
      const id = await signupApi.register(name, toE164(country, phone), callLang)
      setElderId(id)
    })

  async function onPhone(e) {
    e.preventDefault()
    setError(null)
    if (digitsOf(phone).length !== country.digits) {
      setFieldErrors({ phone: t.s2.phoneInvalid(country.digits) })
      return
    }
    setFieldErrors({})
    if (VERIFY_PHONE) {
      if (await run(() => phoneVerification.sendCode(toE164(country, phone)))) {
        setCode('')
        setCooldown(COOLDOWN)
        setPhoneStage('code')
      }
      return
    }
    if (await register()) setStep(3)
  }

  async function onVerify(e) {
    e.preventDefault()
    setError(null)
    if (code.length !== 6) {
      setFieldErrors({ code: t.s2.codeInvalid })
      return
    }
    setFieldErrors({})
    if (!(await run(() => phoneVerification.verifyCode(toE164(country, phone), code)))) return
    if (await register()) setStep(3)
  }

  async function onResend() {
    if (resendsLeft <= 0 || cooldown > 0) return
    clearMessages()
    if (await run(() => phoneVerification.sendCode(toE164(country, phone)))) {
      setResendsLeft((n) => n - 1)
      setCooldown(COOLDOWN)
      setCode('')
    }
  }

  /* ----- step 3: character ----- */
  const matching = (characters || []).filter((c) => c.language === callLang)
  const shown = matching.length ? matching : characters || []
  const selected = shown.find((c) => c.id === characterId) ? characterId : shown[0]?.id || ''

  async function onCharacter(e) {
    e.preventDefault()
    if (!selected) {
      setFieldErrors({ character: t.sChar.pickOne })
      return
    }
    clearMessages()
    if (await run(() => signupApi.setCharacter(elderId, selected))) {
      setCharacterId(selected)
      setCharacterName(shown.find((c) => c.id === selected)?.name || '')
      setStep(4)
    }
  }

  /* ----- step 4: LinkedIn ----- */
  async function onLinkedIn(e) {
    e.preventDefault()
    setError(null)
    if (!looksLikeLinkedInProfile(linkedinUrl)) {
      setFieldErrors({ linkedin: t.s3.urlInvalid })
      return
    }
    setFieldErrors({})
    if (!elderId) {
      setError({ code: 'NOT_FOUND' })
      return
    }
    setBusy(true)
    try {
      await signupApi.setLinkedin(elderId, linkedinUrl.trim())
      setLinkedin('saved')
      setStep('done')
    } catch (err) {
      if (err.code === 'LINKEDIN_LOCKED') {
        // Already set up for this number: nothing to change, carry on.
        setLinkedin('saved')
        setStep('done')
      } else {
        setError({ code: err.code || 'SERVER', message: err.message })
      }
    } finally {
      setBusy(false)
    }
  }

  function onSkip() {
    clearMessages()
    setLinkedin('skipped')
    setStep('done')
  }

  function goBack() {
    clearMessages()
    if (step === 4) setStep(3)
    else if (step === 3) setStep(2)
    else if (step === 2 && phoneStage === 'code') setPhoneStage('number')
    else if (step === 2) setStep(1)
  }

  const heading = 'font-display text-3xl font-bold text-tinta-900 md:text-[2.5rem] md:leading-[1.1]'
  const sceneStep = step === 'done' ? 4 : Math.min(step, 3)
  const lostSignup = error?.code === 'NOT_FOUND'

  return (
    <Shell
      t={t}
      sceneStep={sceneStep}
      onToggle={() => {
        setLangPinned(true)
        setLang(lang === 'es' ? 'en' : 'es')
      }}
    >
      {step !== 'done' && (
        <StepHeader step={step} total={TOTAL_STEPS} label={t.stepOf(step, TOTAL_STEPS)} title={t.stepTitles[step - 1]} />
      )}

      {/* key restarts the gentle fade each time the screen changes */}
      <div key={`${step}-${phoneStage}`} className="flex flex-1 flex-col gap-6 motion-safe:animate-rise">
        {step !== 1 && step !== 'done' && <BackButton onClick={goBack}>{t.back}</BackButton>}

        {/* ---------- Screen 1: name + language ---------- */}
        {step === 1 && (
          <>
            <header className="flex flex-col gap-3">
              <h1 ref={headingRef} tabIndex={-1} className={heading}>
                {t.s1.title}
              </h1>
              <p>{t.s1.lead}</p>
            </header>
            <form noValidate onSubmit={onName} className="flex flex-1 flex-col gap-5">
              <TextField
                id="name"
                autoComplete="name"
                maxLength={MAX_NAME + 20}
                label={t.s1.name}
                hint={t.s1.nameHint}
                error={fieldErrors.name}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <RadioCards
                name="callLang"
                legend={t.s1.langLabel}
                value={callLang}
                onChange={chooseCallLang}
                options={[
                  { value: 'es', label: t.s1.langEs },
                  { value: 'en', label: t.s1.langEn },
                ]}
              />
              <div className="flex-1" />
              <Button type="submit">{t.s1.continue}</Button>
            </form>
          </>
        )}

        {/* ---------- Screen 2: phone, number (then code when VERIFY_PHONE) ---------- */}
        {step === 2 && phoneStage === 'number' && (
          <>
            <header className="flex flex-col gap-3">
              <h1 ref={headingRef} tabIndex={-1} className={heading}>
                {t.s2.title}
              </h1>
              <p>{VERIFY_PHONE ? t.s2.lead : t.s2.leadCall}</p>
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
              <ErrorBanner>{errorText(error)}</ErrorBanner>
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
              <ErrorBanner>{errorText(error)}</ErrorBanner>
              <Button type="submit" disabled={busy}>
                {busy ? t.working : t.s2.verify}
              </Button>
              <div className="flex flex-col gap-3" aria-live="polite">
                <Button variant="secondary" onClick={onResend} disabled={busy || cooldown > 0 || resendsLeft <= 0}>
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

        {/* ---------- Screen 3: character ---------- */}
        {step === 3 && (
          <>
            <header className="flex flex-col gap-3">
              <h1 ref={headingRef} tabIndex={-1} className={heading}>
                {t.sChar.title}
              </h1>
              <p>{t.sChar.lead}</p>
            </header>
            {!characters && !charsFailed && (
              <p aria-live="polite" className="text-lg text-tinta-700">
                {t.sChar.loading}
              </p>
            )}
            {charsFailed && (
              <div className="flex flex-col gap-4">
                <ErrorBanner>{t.sChar.loadFailed}</ErrorBanner>
                <Button variant="secondary" onClick={() => setCharsFailed(false)}>
                  {t.sChar.retry}
                </Button>
              </div>
            )}
            {characters && (
              <form noValidate onSubmit={onCharacter} className="flex flex-1 flex-col gap-5">
                <RadioCards
                  name="character"
                  legend={t.sChar.title}
                  value={selected}
                  onChange={(id) => {
                    setCharacterId(id)
                    setFieldErrors({})
                  }}
                  error={fieldErrors.character}
                  options={shown.map((c) => ({
                    value: c.id,
                    label: c.name,
                    badge: t.sChar.speaks[c.language] || '',
                    description: c.description,
                  }))}
                />
                <ErrorBanner>{errorText(error)}</ErrorBanner>
                <div className="flex-1" />
                <Button type="submit" disabled={busy || !shown.length}>
                  {busy ? t.working : t.sChar.continue}
                </Button>
              </form>
            )}
          </>
        )}

        {/* ---------- Screen 4: LinkedIn (optional) ---------- */}
        {step === 4 && (
          <>
            <header className="flex flex-col gap-3">
              <h1 ref={headingRef} tabIndex={-1} className={heading}>
                {t.s3.title}
              </h1>
              <p>{t.s3.lead}</p>
            </header>
            <form noValidate onSubmit={onLinkedIn} className="flex flex-1 flex-col gap-5">
              <TextField
                id="linkedin"
                type="url"
                inputMode="url"
                autoComplete="url"
                label={t.s3.url}
                hint={t.s3.urlHint}
                error={fieldErrors.linkedin}
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
              />
              <ErrorBanner>{errorText(error)}</ErrorBanner>
              <div className="flex-1" />
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
        )}

        {/* ---------- Done: call me now + what happens with the call (DoneStep.jsx) ---------- */}
        {step === 'done' && (
          <DoneStep
            t={t}
            name={name}
            characterName={characterName}
            linkedin={linkedin}
            elderId={elderId}
            headingRef={headingRef}
            headingClass={heading}
            errorText={errorText}
            onStartOver={startOver}
          />
        )}

        {lostSignup && step !== 'done' && (
          <Button variant="quiet" onClick={startOver}>
            {t.done.startOver}
          </Button>
        )}
      </div>
    </Shell>
  )
}
