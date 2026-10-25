import { useEffect, useRef, useState } from 'react'
import { isConfigured, looksLikeAppPassword, phoneVerification, signupApi, tidyBlueskyHandle } from './api'
import { COUNTRIES, STRINGS } from './i18n'
import { digitsOf, formatNational, toE164 } from './phone'
import {
  BackButton,
  Button,
  BlueskyIcon,
  ErrorBanner,
  LangToggle,
  Note,
  PasswordField,
  RadioCards,
  SelectField,
  StepHeader,
  TalaveraBand,
  TextField,
} from './ui'
import { DoneStep } from './DoneStep'
import { OAUTH_KEY, OAuthConnect } from './OAuthConnect'
import { Scene, SvgDefs } from './Scene'

// Flow (convex/signup.ts): 1 name + language -> 2 phone (register: elderId + sign-up token)
// -> 3 character (setCharacter) -> 4 Bluesky, optional (connectBluesky: handle + app password; Threads and X via
// OAuthConnect.jsx -> startOAuthConnect, a round trip to Meta / X) -> done: "Call me now" (requestCall) + call status (DoneStep.jsx).
//
// The backend has no SMS verification yet, so the 6-digit code screen is skipped. Turn this on
// (and replace phoneVerification in api.js with a real provider) once it exists.
const VERIFY_PHONE = false

const TOTAL_STEPS = 4
const KEY = 'onboarding-v2'
const COOLDOWN = 30
const MAX_NAME = 100

// Progress (and the sign-up token) survives a refresh in sessionStorage. The SMS code and the
// app password are never stored.
const load = () => {
  try {
    const state = JSON.parse(sessionStorage.getItem(KEY)) || {}
    // A sign-up without its token (saved by an older version) can't go on: start fresh.
    if (state.elderId && !state.token) {
      clearSaved()
      return {}
    }
    return state
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
    sessionStorage.removeItem(OAUTH_KEY) // connected OAuth platforms (OAuthConnect.jsx)
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
  const [token, setToken] = useState(saved.token || null) // from register; every later step needs it
  const [characters, setCharacters] = useState(null) // null = not loaded
  const [charsFailed, setCharsFailed] = useState(false)
  const [characterId, setCharacterId] = useState(saved.characterId || '')
  const [characterName, setCharacterName] = useState(saved.characterName || '')
  const [bskyHandle, setBskyHandle] = useState(saved.bskyHandle || '')
  const [appPassword, setAppPassword] = useState('') // memory only, cleared once used
  const [bluesky, setBluesky] = useState(saved.bluesky || null) // 'saved' | 'skipped' | 'locked' | null
  const [connectedHandle, setConnectedHandle] = useState(saved.connectedHandle || '')
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
      elderId, token, characterId, characterName, bskyHandle, bluesky, connectedHandle,
    })
    document.documentElement.lang = t.htmlLang
  }, [lang, langPinned, step, phoneStage, name, callLang, countryCode, phone, resendsLeft, elderId, token, characterId, characterName, bskyHandle, bluesky, connectedHandle, t.htmlLang])

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
    if (e.code === 'BLUESKY') return e.message // already in his language (t.sBsky.errors)
    if (e.code === 'SERVER' && e.message && e.message !== 'SERVER') return e.message
    return t.errors[e.code] || t.errors.SERVER
  }

  async function run(task) {
    setBusy(true)
    setError(null)
    try {
      if (step !== 1 && step !== 2 && (!elderId || !token)) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
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
      const res = await signupApi.register(name, toE164(country, phone), callLang)
      if (!res?.ok) throw Object.assign(new Error('ALREADY_SIGNED_UP'), { code: 'ALREADY_SIGNED_UP' })
      setElderId(res.elderId)
      setToken(res.token)
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
    if (await run(() => signupApi.setCharacter(elderId, token, selected))) {
      setCharacterId(selected)
      setCharacterName(shown.find((c) => c.id === selected)?.name || '')
      setStep(4)
    }
  }

  /* ----- step 4: Bluesky ----- */
  async function onBluesky(e) {
    e.preventDefault()
    setError(null)
    const errs = {}
    if (!tidyBlueskyHandle(bskyHandle)) errs.handle = t.sBsky.handleInvalid
    if (!looksLikeAppPassword(appPassword)) errs.password = t.sBsky.passwordInvalid
    setFieldErrors(errs)
    if (Object.keys(errs).length) return
    if (!elderId || !token) {
      setError({ code: 'NOT_FOUND' })
      return
    }
    setBusy(true)
    try {
      const res = await signupApi.connectBluesky(elderId, token, bskyHandle.trim(), appPassword)
      if (res?.ok) {
        setAppPassword('')
        setConnectedHandle(res.handle || tidyBlueskyHandle(bskyHandle))
        setBluesky('saved')
        setStep('done')
      } else if (res?.error === 'locked') {
        // He's already active: his accounts are set up with us, carry on.
        setAppPassword('')
        setBluesky('locked')
        setStep('done')
      } else if (res?.error === 'not_found') {
        setError({ code: 'NOT_FOUND' })
      } else {
        setError({ code: 'BLUESKY', message: t.sBsky.errors[res?.error] || t.sBsky.errors.failed })
      }
    } catch (err) {
      setError({ code: err.code || 'SERVER', message: err.message })
    } finally {
      setBusy(false)
    }
  }

  function onSkip() {
    clearMessages()
    setAppPassword('')
    setBluesky('skipped')
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

        {/* ---------- Screen 4: Bluesky (optional) ---------- */}
        {step === 4 && (
          <>
            <header className="flex flex-col gap-3">
              <h1 ref={headingRef} tabIndex={-1} className={heading}>
                {t.sBsky.title}
              </h1>
              <p>{t.sBsky.lead}</p>
            </header>
            <section className="flex flex-col gap-3">
              <h2 className="text-xl font-bold text-tinta-900">{t.sBsky.howTitle}</h2>
              <ol className="ml-7 flex list-decimal flex-col gap-2 text-lg">
                {t.sBsky.how.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              <a
                href="https://bsky.app/settings/app-passwords"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-touch flex-wrap items-center gap-x-2 self-start rounded-xl px-1 text-xl font-bold text-talavera-700 underline underline-offset-4 hover:text-talavera-900"
              >
                {t.sBsky.link}
                <span className="text-lg font-normal">{t.sBsky.linkNote}</span>
              </a>
            </section>
            <form noValidate onSubmit={onBluesky} className="flex flex-1 flex-col gap-5">
              <TextField
                id="bsky-handle"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                label={t.sBsky.handle}
                hint={t.sBsky.handleHint}
                error={fieldErrors.handle}
                value={bskyHandle}
                onChange={(e) => setBskyHandle(e.target.value)}
              />
              <PasswordField
                id="bsky-app-password"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                label={t.sBsky.password}
                hint={t.sBsky.passwordHint}
                error={fieldErrors.password}
                labels={t.sBsky}
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
              />
              <Note>{t.sBsky.safety}</Note>
              <p className="text-lg font-bold">{t.sBsky.use}</p>
              <ErrorBanner>{errorText(error)}</ErrorBanner>
              <div className="flex-1" />
              <div className="flex flex-col gap-4">
                <Button type="submit" icon={<BlueskyIcon />} disabled={busy}>
                  {busy ? t.sBsky.connecting : t.sBsky.save}
                </Button>
                <Button variant="secondary" onClick={onSkip} disabled={busy}>
                  {t.sBsky.skip}
                </Button>
              </div>
              <section className="flex flex-col gap-3">
                <h2 className="text-xl font-bold text-tinta-900">{t.sBsky.otherTitle}</h2>
                <OAuthConnect t={t} elderId={elderId} token={token} />
                <Button variant="secondary" disabled>
                  {t.sBsky.reddit}
                </Button>
              </section>
            </form>
          </>
        )}

        {/* ---------- Done: call me now + what happens with the call (DoneStep.jsx) ---------- */}
        {step === 'done' && (
          <DoneStep
            t={t}
            name={name}
            characterName={characterName}
            bluesky={bluesky}
            connectedHandle={connectedHandle}
            elderId={elderId}
            token={token}
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
