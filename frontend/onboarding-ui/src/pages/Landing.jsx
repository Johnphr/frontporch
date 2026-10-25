// Landing page (#/), the "Large & Calm" mockup (design-mockups/landing-c-calm.html).
// Six short chapters on white, split by hairlines; only the example post sits on the wash (DESIGN.md). Every sign-up link goes to #/signin.
import { CallArt, CheckIcon, HeroArt, PostArt, PromiseArt, SignUpArt } from '../art/landing'
import { NAV } from '../copy'
import { HERO, HOW, PROMISES } from '../copy/landing'
import { Button, cx } from '../ui/controls'
import { Footer, Header, NAV_ITEM } from '../ui/Header'
import { Art, Band, ExamplePost, Family, FinalCta, H2, P, Split, STACK, WRAP } from './LandingSections'

export default function Landing() {
  return (
    <>
      <Header>
        <a href="#/signin" className={NAV_ITEM}>
          {NAV.signIn}
        </a>
        {/* Hidden on narrow phones: the hero button is right below. */}
        <Button href="#/signin" small className="max-sm:!w-auto max-[560px]:hidden">
          {NAV.getStarted}
        </Button>
      </Header>
      <main id="main">
        <Hero />
        <HowItWorks />
        <ExamplePost />
        <Promises />
        <Family />
        <FinalCta />
      </main>
      <Footer />
    </>
  )
}

function Hero() {
  return (
    <Band first aria-labelledby="hero-title">
      <Split cols="even" className={WRAP}>
        <div className="flex flex-col items-start gap-7">
          <h1 id="hero-title" className="max-w-[14ch] text-display">
            {HERO.title}
          </h1>
          <p className={cx(P, 'text-lg')}>{HERO.lead}</p>
          <Button href="#/signin">{HERO.cta}</Button>
          <a href="#/signin" className="text-[1.25rem] font-bold">
            {HERO.family}
          </a>
        </div>
        <Art className="max-w-[34rem]">
          <HeroArt label={HERO.art} />
        </Art>
      </Split>
    </Band>
  )
}

const STEP_ART = [SignUpArt, CallArt, PostArt]

function HowItWorks() {
  return (
    <Band aria-labelledby="how-title">
      <div className={WRAP}>
        <div className={cx(STACK, 'max-w-[47.5rem]')}>
          <h2 id="how-title" className={H2}>
            {HOW.title}
          </h2>
          <p className={P}>{HOW.lead}</p>
        </div>
        <ol className="mt-14 flex flex-col gap-[clamp(3rem,6vw,5rem)]">
          {HOW.steps.map((step, i) => {
            const StepArt = STEP_ART[i]
            const flip = i === 1 // the middle step has its picture on the left
            return (
              <Split as="li" key={step.title} cols={flip ? '5-7' : '7-5'}>
                <div className={STACK}>
                  <span aria-hidden="true" className="inline-grid h-[3.75rem] w-[3.75rem] place-items-center rounded-full border-2 border-ink bg-white font-display text-[1.875rem] font-semibold leading-none text-ink">
                    {i + 1}
                  </span>
                  <h3 className="text-subhead">
                    <span className="sr-only">{HOW.stepLabel(i + 1)}</span>
                    {step.title}
                  </h3>
                  <p className={P}>{step.body}</p>
                </div>
                <Art first={flip} className="max-w-[20rem]">
                  <StepArt />
                </Art>
              </Split>
            )
          })}
        </ol>
      </div>
    </Band>
  )
}

function Promises() {
  return (
    <Band aria-labelledby="promise-title">
      <Split className={WRAP}>
        <div className={STACK}>
          <h2 id="promise-title" className={H2}>
            {PROMISES.title}
          </h2>
          <p className={P}>{PROMISES.lead}</p>
          <ul className="flex flex-col gap-7">
            {PROMISES.items.map((item) => (
              <li key={item.title} className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-[1.125rem]">
                <CheckIcon />
                <div>
                  <strong className="block font-display text-[1.625rem] leading-[1.3]">{item.title}</strong> {item.body}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <Art>
          <PromiseArt />
        </Art>
      </Split>
    </Band>
  )
}
