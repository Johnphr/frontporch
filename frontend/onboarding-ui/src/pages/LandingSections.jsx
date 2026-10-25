// Landing layout pieces (bands, splits, art boxes) and the lower half of the page.
import { Avatar, FamilyArt, PorchArt } from '../art/landing2'
import { FAMILY, FINAL, POST } from '../copy/landing'
import { Button, cx } from '../ui/controls'
import { branded } from '../ui/Brand'

export const WRAP = 'mx-auto w-full max-w-[70rem] px-5 sm:px-8'
export const STACK = 'flex flex-col items-start gap-6'
export const H2 = 'text-heading'
export const P = 'max-w-[40rem]'
const CARD_PAD = 'rounded-card bg-white p-[clamp(1.5rem,4vw,2.25rem)]'

/** Full-width section on white; a hairline and generous vertical silence pace the page like
 *  chapters. `wash` gives the one tinted band; `first` drops the top rule (under the header). */
export function Band({ wash, first, className, children, ...rest }) {
  return (
    <section
      className={cx(wash ? 'bg-wash' : 'bg-white', !first && 'border-t border-line', 'py-[clamp(4rem,3rem_+_5vw,8rem)]', className)}
      {...rest}
    >
      {children}
    </section>
  )
}

// Text + art side by side from 896px (56rem) up; stacked on phones.
const SPLITS = {
  '7-5': 'min-[896px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]',
  '5-7': 'min-[896px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]',
  even: 'min-[896px]:grid-cols-2',
}

/** `cols` is the column ratio on wide screens: "7-5" (default), "5-7" or "even". */
export function Split({ as: Tag = 'div', cols = '7-5', className, children }) {
  return <Tag className={cx('grid items-center gap-10 min-[896px]:gap-[4.5rem]', SPLITS[cols], className)}>{children}</Tag>
}

/** Centered illustration box. `first` puts it on the left on wide screens. */
export function Art({ first, className = 'max-w-[26rem]', children }) {
  return <div className={cx('w-full justify-self-center', first && 'min-[896px]:order-first', className)}>{children}</div>
}

export function ExamplePost() {
  return (
    <Band wash aria-labelledby="post-title">
      <Split cols="5-7" className={WRAP}>
        <div className={STACK}>
          <h2 id="post-title" className={H2}>
            {POST.title}
          </h2>
          <p className={P}>{POST.lead}</p>
        </div>
        <article aria-label={POST.label} className={cx(CARD_PAD, 'flex w-full max-w-[38rem] flex-col gap-5 justify-self-center border border-line shadow-card')}>
          <span className="tag">{POST.tag}</span>
          <div className="flex items-center gap-4">
            <Avatar who="margaret" />
            <div>
              <div className="font-bold leading-[1.3]">{POST.name}</div>
              <div className="text-[1.125rem] leading-[1.4]">{POST.meta}</div>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            {POST.body.map((para) => (
              <p key={para}>{para}</p>
            ))}
          </div>
          <p className="border-t border-line pt-4 text-sm italic">{branded(POST.note)}</p>
        </article>
      </Split>
    </Band>
  )
}

export function Family() {
  return (
    <Band id="family" aria-labelledby="family-title">
      <Split className={WRAP}>
        <div className={STACK}>
          <h2 id="family-title" className={H2}>
            {FAMILY.title}
          </h2>
          <p className={P}>{FAMILY.lead}</p>
          <ol className="flex list-decimal flex-col gap-3 pl-8">
            {FAMILY.steps.map((s) => (
              <li key={s} className="pl-2 marker:font-display marker:font-semibold marker:text-ink">
                {s}
              </li>
            ))}
          </ol>
          <Button href="#/signin">{FAMILY.cta}</Button>
        </div>
        <Art>
          <FamilyArt />
        </Art>
      </Split>
    </Band>
  )
}

export function FinalCta() {
  return (
    <Band id="get-started" aria-labelledby="final-title" className="text-center">
      <div className={cx(WRAP, 'flex flex-col items-center gap-6')}>
        <Art className="max-w-[24rem]">
          <PorchArt />
        </Art>
        <h2 id="final-title" className={H2}>
          {FINAL.title}
        </h2>
        <p className={cx(P, 'mx-auto text-lg')}>{FINAL.lead}</p>
        <Button href="#/signin">{FINAL.cta}</Button>
        <p className={cx(P, 'mx-auto text-sm')}>{FINAL.small}</p>
      </div>
    </Band>
  )
}
