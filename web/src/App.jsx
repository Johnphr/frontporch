import { useEffect, useRef, useState } from 'react'
import { authApi } from './api'
import { useBackend } from './backend'
import { COUNTRIES, STRINGS } from './i18n'
import { digitsOf, toE164 } from './phone'
import { BackButton, LangToggle, StepHeader, TalaveraBand } from './ui'
import { Scene, SvgDefs } from './Scene'
import { loadElderId, loadProgress, saveElderId, saveProgress } from './storage'
import SignIn from './steps/SignIn'
import Phone from './steps/Phone'
import Character from './steps/Character'
import LinkedIn from './steps/LinkedIn'
import Done from './steps/Done'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LINKEDIN_RE = /^(https?:\/\/)?([\w-]+\.)?linkedin\.com\/\S+$/i
const COOLDOWN = 30
const TOTAL_STEPS = 4

export default function App() {
  const saved = useRef(loadProgress()).current
  const backend = useBackend()
  const [elderId, setElderId] = useState(loadElderId)
  const [lang, setLang] = useState(saved.lang || 'es')
  // 1 sign in | 2 phone | 3 who calls | 4 LinkedIn | 'done'. Steps 3+ need an elder id.
  const [step, setStep] = useState(() => {
    const s = saved.step || 1
    return elderId || s === 1 || s === 2 ? s : 2
  })
  const [phoneStage, setPhoneStage] = useState(saved.phoneStage || 'number')
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState(saved.email || '')
  const [password, setPassword] = useState('')
  const [name, setName] = useState(saved.name || '')
  const [countryCode, setCountryCode] = useState(saved.countryCode || 'MX')
  const [phone, setPhone] = useState(saved.phone || '')
  const [code, setCode] = useState('')
  const [resendsLeft, setResendsLeft] = useState(saved.resendsLeft ?? 3)
  const [cooldown, setCooldown] = useState(0)
  const [character, setCharacter] = useState(saved.character || null) // { id, name }
  const [changingCharacter, setChangingCharacter] = useState(false)
  const [linkedinUrl, setLinkedinUrl] = useState(saved.linkedinUrl || '')
  const [linkedin, setLinkedin] = useState(saved.linkedin || null) // 'saved' | 'skipped'
  const [callResult, setCallResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})

  const t = STRINGS[lang]
  const country = COUNTRIES.find((c) => c.code === countryCode)
  const headingRef = useRef(null)
  const firstRender = useRef(true)

  useEffect(() => {
    saveProgress({ lang, step, phoneStage, email, name, countryCode, phone, resendsLeft, character, linkedinUrl, linkedin })
    document.documentElement.lang = t.htmlLang
  }, [lang, step, phoneStage, email, name, countryCode, phone, resendsLeft, character, linkedinUrl, linkedin, t.htmlLang])

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
      setError(t.errors[e.code] || t.errors.SERVER)
      return false
    } finally {
      setBusy(false)
    }
  }

  /* ----- step 1: sign in (fake) ----- */
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

  /* ----- step 2: name + phone, then the code (fake), then register ----- */
  async function onPhone(e) {
    e.preventDefault()
    setError('')
    const errs = {}
    if (!name.trim()) errs.name = t.s2.nameMissing
    if (digitsOf(phone).length !== country.digits) errs.phone = t.s2.phoneInvalid(country.digits)
    setFieldErrors(errs)
    if (Object.keys(errs).length) return
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
    const e164 = toE164(country, phone)
    const ok = await run(async () => {
      await authApi.verifyCode(e164, code)
      const id = await backend.register({ name: name.trim(), phone: e164, language: lang })
      setElderId(id)
      saveElderId(id)
    })
    if (ok) setStep(3)
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

  /* ----- step 3: who calls ----- */
  async function onChooseCharacter(c) {
    clearMessages()
    if (await run(() => backend.setCharacter({ elderId, characterId: c.id }))) {
      setCharacter({ id: c.id, name: c.name })
      setCallResult(null)
      setStep(changingCharacter ? 'done' : 4)
      setChangingCharacter(false)
    }
  }

  /* ----- step 4: LinkedIn (optional) ----- */
  async function onSaveLinkedin(e) {
    e.preventDefault()
    setError('')
    const raw = linkedinUrl.trim()
    if (!LINKEDIN_RE.test(raw)) {
      setFieldErrors({ linkedin: t.s3.urlInvalid })
      return
    }
    setFieldErrors({})
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    if (await run(() => backend.setLinkedin({ elderId, url }))) {
      setLinkedin('saved')
      setStep('done')
    }
  }

  function onSkipLinkedin() {
    clearMessages()
    setLinkedin('skipped')
    setStep('done')
  }

  /* ----- done ----- */
  async function onCallNow() {
    clearMessages()
    setCallResult(null)
    let res
    if (await run(async () => (res = await backend.requestCall({ elderId })))) {
      if (!res?.ok) console.warn('requestCall refused', res)
      setCallResult(res?.ok ? 'ok' : res?.reason || 'failed')
    }
  }

  function onChangeCaller() {
    clearMessages()
    setCallResult(null)
    setChangingCharacter(true)
    setStep(3)
  }

  function goBack() {
    clearMessages()
    if (step === 4) setStep(3)
    else if (step === 3 && changingCharacter) {
      setChangingCharacter(false)
      setStep('done')
    } else if (step === 3) setStep(2)
    else if (step === 2 && phoneStage === 'code') setPhoneStage('number')
    else if (step === 2) setStep(1)
  }

  const common = { t, lang, headingRef, busy, error, fieldErrors }
  const sceneStep = step === 'done' ? 4 : Math.min(step, 3)

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
            <LangToggle label={t.langName} ariaLabel={t.langAria} onClick={() => setLang(lang === 'es' ? 'en' : 'es')} />
          </div>

          {step !== 'done' && (
            <StepHeader step={step} total={TOTAL_STEPS} label={t.stepOf(step)} title={t.stepTitles[step - 1]} />
          )}

          {/* key restarts the gentle fade each time the screen changes */}
          <div key={`${step}-${phoneStage}-${mode}`} className="flex flex-1 flex-col gap-6 motion-safe:animate-rise">
            {step !== 1 && step !== 'done' && (
              <BackButton onClick={goBack} disabled={busy}>
                {t.back}
              </BackButton>
            )}

            {step === 1 && (
              <SignIn
                {...common}
                form={{ mode, email, setEmail, password, setPassword }}
                onGoogle={onGoogle}
                onAccount={onAccount}
                onToggleMode={() => {
                  clearMessages()
                  setMode(mode === 'signin' ? 'register' : 'signin')
                }}
              />
            )}

            {step === 2 && (
              <Phone
                {...common}
                form={{ stage: phoneStage, name, setName, country, countryCode, phone, setPhone, code, setCode, cooldown, resendsLeft }}
                actions={{
                  onCountry: (value) => {
                    setCountryCode(value)
                    setPhone('')
                    setFieldErrors({})
                  },
                  onPhone,
                  onVerify,
                  onResend,
                  onChangeNumber: () => {
                    clearMessages()
                    setPhoneStage('number')
                  },
                }}
              />
            )}

            {step === 3 && <Character {...common} currentId={character?.id} onChoose={onChooseCharacter} />}

            {step === 4 && (
              <LinkedIn
                {...common}
                url={linkedinUrl}
                setUrl={setLinkedinUrl}
                onSave={onSaveLinkedin}
                onSkip={onSkipLinkedin}
              />
            )}

            {step === 'done' && (
              <Done
                {...common}
                characterName={character?.name}
                linkedin={linkedin}
                callResult={callResult}
                onCallNow={onCallNow}
                onChangeCaller={onChangeCaller}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
