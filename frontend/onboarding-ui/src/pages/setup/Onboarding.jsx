// First-time setup (#/setup, design-mockups/onboarding-c.html): six steps, then Done.
//   1 who  2 name  3 language + host  4 day + time  5 LinkedIn  6 review -> Finish (finish.js)  7 done
// "Change" on Review opens that step, and its button then goes straight back to Review.
// The phone comes from sign-in (session); after an email sign-in Review asks for it.
import { useEffect, useRef, useState } from 'react'
import { HOSTS } from '../../copy'
import { SETUP, TOTAL_STEPS, setupCopy } from '../../copy/setup'
import { go } from '../../lib/route'
import { loadSession } from '../../lib/session'
import { BackChevron } from '../../art/setup'
import { Header } from '../../ui/Header'
import { Button } from '../../ui/controls'
import Done from './Done'
import Review from './Review'
import { LanguageStep } from './LanguageStep'
import { LinkedinStep, NameStep, WhenStep, WhoStep } from './steps'

const STEPS = { 1: WhoStep, 2: NameStep, 3: LanguageStep, 4: WhenStep, 5: LinkedinStep }

export default function Onboarding() {
  const [signedInPhone] = useState(() => loadSession().phone || '')
  const [data, setData] = useState(() => ({
    who: null, // 'self' | 'helper'
    name: '',
    language: 'en',
    host: 'daniel', // host id (copy.js HOSTS); the language's default until they pick one
    callDay: 'tuesday',
    callHour: 11,
    linkedin: '', // as typed
    liStatus: 'later', // 'url' | 'none' | 'later'
    phone: signedInPhone, // E.164, '' until they add one
  }))
  const [step, setStep] = useState(1)
  const [toReview, setToReview] = useState(false)
  const [forward, setForward] = useState(true) // which way the next step slides in
  const [result, setResult] = useState(null) // finishSetup() + phone, for Done
  const heading = useRef(null)
  const shown = useRef(step)

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

  function next() {
    setForward(true)
    setToReview(false)
    setStep((s) => (toReview ? 6 : s + 1))
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
  function finished(res) {
    setForward(true)
    setResult(res)
    setStep(7)
  }

  const Step = STEPS[step]
  const backLabel = toReview ? SETUP.backReview : step === 1 ? SETUP.backHome : SETUP.back

  return (
    <>
      <Header />
      <main id="main" className="mx-auto w-full max-w-[40rem] overflow-x-clip px-4 pb-16 pt-6 sm:px-6">
        {step <= TOTAL_STEPS && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <Button variant="link" small onClick={back}>
                <BackChevron />
                {backLabel}
              </Button>
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
          {step === 6 && (
            <Review data={data} set={set} words={words} headingRef={heading} signedInPhone={signedInPhone} onGoto={change} onDone={finished} />
          )}
          {step === 7 && result && (
            <Done
              words={words}
              host={host}
              headingRef={heading}
              elderId={result.elderId}
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
