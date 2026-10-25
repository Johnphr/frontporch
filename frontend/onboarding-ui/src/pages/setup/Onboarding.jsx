// First-time setup (#/setup, design-mockups/onboarding-c.html): six steps, then Done.
//   1 who  2 name  3 language + host  4 day + time  5 review -> save (finish.js saveSetup: register,
//   host, weekly slot)  6 accounts (Bluesky, Threads, X; optional) -> Finish rings him  7 done
// "Change" on Review opens that step, and its button then goes straight back to Review.
// The phone comes from sign-in (session); after an email sign-in Review asks for it.
// Progress is kept in sessionStorage (SETUP_KEY), so a refresh or the Threads / X round trip
// doesn't lose it. The app password and the sign-up token are never in it (the token lives in
// the session, lib/session.js).
import { useEffect, useRef, useState } from 'react'
import { HOSTS, hostForLanguage } from '../../copy'
import { SETUP, TOTAL_STEPS, setupCopy } from '../../copy/setup'
import { go } from '../../lib/route'
import { SETUP_KEY, loadSession } from '../../lib/session'
import { BackChevron } from '../../art/setup'
import { Header } from '../../ui/Header'
import { Button } from '../../ui/controls'
import AccountsStep from './Accounts'
import Done from './Done'
import Review from './Review'
import { placeCall } from './finish'
import { LanguageStep, NameStep, WhenStep, WhoStep } from './steps'

const STEPS = { 1: WhoStep, 2: NameStep, 3: LanguageStep, 4: WhenStep }
const REVIEW = 5
const ACCOUNTS = 6

/** Saved progress for this sign-in, or null. A saved step 6 needs the sign-up it was saved with. */
function loadProgress() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SETUP_KEY))
    if (!saved || typeof saved !== 'object' || !saved.data) return null
    const session = loadSession()
    if (saved.elderId && (saved.elderId !== session.elderId || !session.token)) return null
    const step = Number(saved.step)
    if (!(step >= 1 && step <= TOTAL_STEPS)) return null
    return { data: saved.data, step: step === ACCOUNTS && !saved.elderId ? REVIEW : step, elderId: saved.elderId }
  } catch {
    return null
  }
}

function saveProgress(value) {
  try {
    if (value) sessionStorage.setItem(SETUP_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(SETUP_KEY)
  } catch {
    /* storage unavailable: progress just won't survive a refresh */
  }
}

export default function Onboarding() {
  const saved = useRef(loadProgress()).current
  const [signedInPhone] = useState(() => loadSession().phone || '')
  const [data, setData] = useState(() => ({
    who: null, // 'self' | 'helper'
    name: '',
    language: 'en',
    callDay: 'tuesday',
    callHour: 11,
    phone: signedInPhone, // E.164, '' until they add one
    bluesky: undefined, // { status: 'saved', handle } | { status: 'locked' } once step 6 connects it
    ...saved?.data,
  }))
  const [step, setStep] = useState(saved?.step || 1)
  const [signup, setSignup] = useState(() => {
    if (!saved?.elderId) return null
    const { elderId, token } = loadSession()
    return { elderId, token }
  }) // { elderId, token } once Review saved it
  const [toReview, setToReview] = useState(false)
  const [result, setResult] = useState(null) // placeCall() + phone, for Done
  const heading = useRef(null)
  const shown = useRef(step)

  // Keep progress until Done (the sign-up itself is saved by then).
  useEffect(() => {
    saveProgress(step <= TOTAL_STEPS ? { data, step, elderId: signup?.elderId } : null)
  }, [data, step, signup])

  // A new step: back to the top, focus its h1 (not on first load).
  useEffect(() => {
    if (shown.current === step) return
    shown.current = step
    window.scrollTo(0, 0)
    heading.current?.focus()
  }, [step])

  const set = (patch) => setData((d) => ({ ...d, ...patch }))
  const host = HOSTS[hostForLanguage(data.language)].name
  const words = setupCopy({ them: data.who === 'helper', name: data.name, host })

  function next() {
    setToReview(false)
    setStep((s) => (toReview ? REVIEW : s + 1))
  }
  function back() {
    if (toReview) return next()
    if (step === 1) return go('/')
    setStep((s) => s - 1)
  }
  function change(n) {
    setToReview(true)
    setStep(n)
  }
  function onSaved(res) {
    setSignup({ elderId: res.elderId, token: res.token })
    set({ phone: res.phone })
    setStep(ACCOUNTS)
  }
  async function finish() {
    const res = await placeCall(signup.elderId, signup.token)
    setResult({ ...res, phone: data.phone })
    setStep(TOTAL_STEPS + 1)
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
      <main id="main" className="mx-auto w-full max-w-[40rem] px-4 pb-16 pt-6 sm:px-6">
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
        <section key={step} className="motion-safe:animate-rise">
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
            <Review data={data} set={set} words={words} headingRef={heading} signedInPhone={signedInPhone} onGoto={change} onDone={onSaved} />
          )}
          {step === ACCOUNTS && signup && (
            <AccountsStep
              data={data}
              set={set}
              words={words}
              headingRef={heading}
              elderId={signup.elderId}
              token={signup.token}
              onFinish={finish}
              beforeLeave={beforeLeave}
            />
          )}
          {step === TOTAL_STEPS + 1 && result && (
            <Done
              words={words}
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
