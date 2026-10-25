// First-time setup (#/setup, design-mockups/onboarding-c.html): six steps, then Done.
//   1 who  2 name  3 language + host  4 day + time  5 review -> save (finish.js saveSetup: register,
//   host, weekly slot)  6 accounts (Bluesky, Threads, X; optional) -> Finish rings him  7 done
// "Change" on Review opens that step, and its button then goes straight back to Review.
// The phone comes from sign-in (session); after an email sign-in Review asks for it.
// Progress is kept by lib/setupProgress.js (this tab, and under the elderId once Review saved
// it), so a refresh, a new tab or the Threads / X round trip doesn't lose it, and a refresh on
// Done shows Done again. The app password and the sign-up token are never in it (the token
// lives in the session, lib/session.js).
// The call language (Spanish for Diana) picks the words on step 6, Done's call status and errors.
import { useEffect, useRef, useState } from 'react'
import { HOSTS, hostForLanguage } from '../../copy'
import { SETUP, TOTAL_STEPS, setupCopy } from '../../copy/setup'
import { go } from '../../lib/route'
import { loadSession } from '../../lib/session'
import { ACCOUNTS_STEP, DONE_STEP, loadProgress, saveProgress } from '../../lib/setupProgress'
import { loadCallId } from '../../lib/useCallStatus'
import { BackChevron } from '../../art/setup'
import { Header } from '../../ui/Header'
import { Button } from '../../ui/controls'
import AccountsStep from './Accounts'
import Done from './Done'
import Review from './Review'
import { placeCall } from './finish'
import { LanguageStep } from './LanguageStep'
import { NameStep, WhenStep, WhoStep } from './steps'

const STEPS = { 1: WhoStep, 2: NameStep, 3: LanguageStep, 4: WhenStep }
const REVIEW = 5
const ACCOUNTS = ACCOUNTS_STEP

/** Saved progress for this sign-in, or null. A step 6 without its sign-up goes back to Review. */
function savedProgress() {
  const saved = loadProgress()
  if (!saved) return null
  const session = loadSession()
  if (saved.elderId && (saved.elderId !== session.elderId || !session.token)) return null
  return saved
}

/** 'es' when the calls are in Spanish (a Spanish host, or Spanish chosen), else 'en'. */
export const setupLanguage = (data) => ((HOSTS[data.host]?.language || data.language) === 'es' ? 'es' : 'en')

export default function Onboarding() {
  const saved = useRef(savedProgress()).current
  const [signedInPhone] = useState(() => loadSession().phone || '')
  const [data, setData] = useState(() => {
    const start = {
      who: null, // 'self' | 'helper'
      name: '',
      language: 'en',
      host: 'daniel', // host id (copy.js HOSTS); the language's default until they pick one
      callDay: 'tuesday',
      callHour: 11,
      phone: signedInPhone, // E.164, '' until they add one
      bluesky: undefined, // { status: 'saved', handle } | { status: 'locked' } once step 6 connects it
      ...saved?.data,
    }
    // A host id saved by an older version (Pip, Juanito): the language's default host instead.
    if (!HOSTS[start.host]) start.host = hostForLanguage(start.language)
    return start
  })
  const [step, setStep] = useState(saved?.step || 1)
  const [signup, setSignup] = useState(() => {
    if (!saved?.elderId) return null
    const { elderId, token } = loadSession()
    return { elderId, token }
  }) // { elderId, token } once Review saved it
  const [toReview, setToReview] = useState(false)
  const [forward, setForward] = useState(true) // which way the next step slides in
  // placeCall() + phone, for Done. After a refresh on Done: the saved result, and the callId this
  // tab is still watching (lib/useCallStatus.js).
  const [result, setResult] = useState(() =>
    saved?.step === DONE_STEP ? { reason: loadCallId() ? null : saved.result.reason || null, phone: saved.result.phone || '', callId: loadCallId() || undefined } : null,
  )
  const heading = useRef(null)
  const shown = useRef(step)

  // Keep progress, Done included (a refresh there shows Done again, not step 1).
  useEffect(() => {
    if (step === DONE_STEP && !result) return
    saveProgress({ data, step, elderId: signup?.elderId, ...(step === DONE_STEP ? { result: { reason: result.reason || null, phone: result.phone } } : {}) })
  }, [data, step, signup, result])

  // A new step: back to the top, focus its h1 (not on first load).
  useEffect(() => {
    if (shown.current === step) return
    shown.current = step
    window.scrollTo(0, 0)
    heading.current?.focus()
  }, [step])

  const set = (patch) => setData((d) => ({ ...d, ...patch }))
  const host = HOSTS[data.host].name
  const words = setupCopy({ them: data.who === 'helper', name: data.name, host, hostId: data.host })
  const lang = setupLanguage(data)

  function next() {
    setForward(true)
    setToReview(false)
    setStep((s) => (toReview ? REVIEW : s + 1))
  }
  function back() {
    if (toReview) return next()
    if (step === 1) return go('/')
    setForward(false)
    setStep((s) => s - 1)
  }
  function change(n) {
    setForward(false)
    setToReview(true)
    setStep(n)
  }
  function onSaved(res) {
    setForward(true)
    setSignup({ elderId: res.elderId, token: res.token })
    set({ phone: res.phone })
    setStep(ACCOUNTS)
  }
  async function finish() {
    const res = await placeCall(signup.elderId, signup.token)
    setForward(true)
    setResult({ ...res, phone: data.phone })
    setStep(DONE_STEP)
  }
  // The browser is about to leave for Threads / X: write progress now, not after the next render.
  const beforeLeave = () => saveProgress({ data, step, elderId: signup?.elderId })

  const Step = STEPS[step]
  const backLabel = toReview ? SETUP.backReview : step === 1 ? SETUP.backHome : SETUP.back
  // Once saved, name and phone can't change from here (his page has host and call time).
  const canGoBack = step !== ACCOUNTS

  return (
    <>
      <Header />
      <main id="main" className="mx-auto w-full max-w-[40rem] overflow-x-clip px-4 pb-16 pt-6 sm:px-6">
        {step <= TOTAL_STEPS && (
          <>
            <div className="flex min-h-touch-sm flex-wrap items-center justify-between gap-x-4 gap-y-1">
              {canGoBack ? (
                <Button variant="link" small onClick={back}>
                  <BackChevron />
                  {backLabel}
                </Button>
              ) : (
                <span />
              )}
              <p className="text-sm font-bold">{SETUP.stepOf(step)}</p>
            </div>
            <div aria-hidden="true" className="mb-6 mt-2 h-3 overflow-hidden rounded-full border border-line bg-white">
              <div className="h-full rounded-full bg-rose transition-[width] duration-300 ease-out" style={{ width: `${(step / TOTAL_STEPS) * 100}%` }} />
            </div>
          </>
        )}
        <section key={step} className={forward ? 'motion-safe:animate-rise' : 'motion-safe:animate-rise-back'}>
          {Step && (
            <Step
              data={data}
              set={set}
              words={words}
              headingRef={heading}
              onNext={next}
              nextLabel={toReview ? SETUP.nextReview : SETUP.next}
            />
          )}
          {step === REVIEW && (
            <Review data={data} set={set} words={words} lang={lang} headingRef={heading} signedInPhone={signedInPhone} onGoto={change} onDone={onSaved} />
          )}
          {step === ACCOUNTS && signup && (
            <AccountsStep
              data={data}
              set={set}
              words={words}
              lang={lang}
              host={host}
              headingRef={heading}
              elderId={signup.elderId}
              token={signup.token}
              onFinish={finish}
              beforeLeave={beforeLeave}
            />
          )}
          {step === DONE_STEP && result && (
            <Done
              words={words}
              lang={lang}
              host={host}
              headingRef={heading}
              elderId={signup?.elderId}
              token={signup?.token}
              phone={result.phone}
              callId={result.callId}
              reason={result.reason}
              callDay={data.callDay}
              callHour={data.callHour}
            />
          )}
        </section>
      </main>
    </>
  )
}
