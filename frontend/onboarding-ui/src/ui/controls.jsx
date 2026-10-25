// Shared controls in the "Large & Calm" style: 64px pill buttons, 64px fields with labels that
// are always visible, big choice cards with real radio inputs, and a toast for saved messages.
import { useEffect, useState } from 'react'

export const cx = (...parts) => parts.filter(Boolean).join(' ')

const BUTTON = {
  primary: 'bg-rose text-white hover:bg-rose-dark active:bg-ink',
  secondary: 'bg-white text-rose shadow-[inset_0_0_0_2px_theme(colors.rose.DEFAULT)] hover:bg-rose-wash hover:text-rose-dark',
  link: 'min-h-touch-sm !px-1 bg-transparent text-rose underline underline-offset-4 hover:text-rose-dark hover:decoration-2',
}

/** Pill button. `busy` disables it and shows `busyLabel`. Pass `href` for a link that looks like a button. */
export function Button({ variant = 'primary', small, busy, busyLabel, disabled, className, href, children, ...rest }) {
  const classes = cx(
    'inline-flex items-center justify-center gap-3 rounded-full font-bold no-underline transition-[color,background-color,box-shadow,transform] duration-200 ease-out active:scale-[0.97] active:duration-150 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100',
    small ? 'min-h-touch-sm px-6 text-sm' : 'min-h-touch px-9 text-base',
    variant !== 'link' && !small && 'max-sm:w-full',
    BUTTON[variant],
    className,
  )
  if (href) {
    return (
      <a href={href} className={classes} {...rest}>
        {children}
      </a>
    )
  }
  return (
    <button type="button" {...rest} className={classes} disabled={Boolean(busy || disabled)} aria-busy={busy || undefined}>
      {busy && busyLabel ? busyLabel : children}
    </button>
  )
}

/** Error line under a field or form: red text with a round "!" badge. role=alert so it is read out. */
export function ErrorText({ id, children }) {
  if (!children) return null
  return (
    <p id={id} role="alert" className="flex items-start gap-2.5 rounded-field bg-alert-tint motion-safe:animate-enter px-4 py-3 text-sm font-bold text-alert">
      <span aria-hidden="true" className="mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full bg-alert text-[1rem] text-white">
        !
      </span>
      {children}
    </p>
  )
}

/** Labelled text input. `error` shows under it and marks it invalid. */
export function TextField({ id, label, hint, error, className, ...input }) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  return (
    <div className={cx('flex w-full flex-col gap-2', className)}>
      <label htmlFor={id} className="font-bold">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          'min-h-touch w-full rounded-field border-2 bg-white px-5 text-lg text-ink transition-colors placeholder:text-field hover:border-muted focus:border-ink',
          error ? 'border-[3px] border-alert' : 'border-field',
        )}
        {...input}
      />
      <ErrorText id={`${id}-error`}>{error}</ErrorText>
    </div>
  )
}

/** Labelled select with a drawn chevron. */
export function SelectField({ id, label, children, className, ...select }) {
  return (
    <div className={cx('flex w-full flex-col gap-2', className)}>
      <label htmlFor={id} className="font-bold">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          className="min-h-touch w-full cursor-pointer appearance-none rounded-field border-2 border-field bg-white pl-5 pr-14 text-lg text-ink transition-colors hover:border-muted focus:border-ink"
          {...select}
        >
          {children}
        </select>
        <span aria-hidden="true" className="pointer-events-none absolute right-6 top-1/2 h-3 w-3 -translate-y-3/4 rotate-45 border-b-[3px] border-r-[3px] border-ink" />
      </div>
    </div>
  )
}

/** A big clickable card holding a real radio input (whole card is the label). */
export function ChoiceCard({ name, value, checked, onChange, title, sub, art, invalid }) {
  return (
    <label
      className={cx(
        'flex min-h-[4.5rem] cursor-pointer items-center gap-4 rounded-inset border-2 px-5 py-4 transition-colors hover:border-rose has-[:focus-visible]:outline has-[:focus-visible]:outline-4 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ink',
        checked ? 'border-rose bg-rose-wash shadow-[0_0_0_2px_theme(colors.rose.DEFAULT)]' : invalid ? 'border-alert bg-white' : 'border-field bg-white',
      )}
    >
      {art}
      <span className="flex-1">
        <span className="block text-base font-bold leading-snug">{title}</span>
        {sub && <span className="block text-sm text-muted">{sub}</span>}
      </span>
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={cx('grid h-8 w-8 flex-none place-items-center rounded-full border-2', checked ? 'border-rose bg-rose' : 'border-field bg-white')}
      >
        {checked && (
          <span className="motion-safe:animate-pop">
            <span className="mb-1 block h-4 w-2 rotate-45 border-b-[3px] border-r-[3px] border-white" />
          </span>
        )}
      </span>
    </label>
  )
}

/** Pill toggles for a single choice (days, times). options: [{ value, label, aria? }] */
export function PillChoices({ name, legend, options, value, onChange }) {
  return (
    <fieldset className="w-full min-w-0">
      <legend className="mb-3 font-bold">{legend}</legend>
      <div className="flex flex-wrap gap-3">
        {options.map((o) => {
          const on = o.value === value
          return (
            <label key={o.value} className="cursor-pointer">
              <input type="radio" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} aria-label={o.aria} className="peer sr-only" />
              <span
                className={cx(
                  'inline-flex min-h-[3.5rem] min-w-[4.75rem] items-center justify-center rounded-full border-2 px-5 font-bold transition-colors peer-focus-visible:outline peer-focus-visible:outline-4 peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-ink',
                  on ? 'border-ink bg-ink text-white' : 'border-muted bg-white hover:border-rose hover:bg-rose-wash',
                )}
              >
                {o.label}
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** White card: hairline border, flat (add shadow-card to lift it). */
export function Card({ as: Tag = 'section', className, children, ...rest }) {
  return (
    <Tag className={cx('flex flex-col items-start gap-5 rounded-card border border-line bg-white p-6 sm:p-10', className)} {...rest}>
      {children}
    </Tag>
  )
}

/** A short message that slides up from the bottom, then slides back down after 5 s. Read out by screen readers. */
export function Toast({ message }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!message) return undefined
    setShown(true)
    const t = setTimeout(() => setShown(false), 5000)
    return () => clearTimeout(t)
  }, [message])
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'fixed bottom-6 left-1/2 z-20 w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 rounded-inset bg-ink px-6 py-5 text-base font-bold text-white shadow-overlay transition-[opacity,transform] duration-[400ms] ease-[ease]',
        shown ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-[calc(100%+1.5rem)] opacity-0',
      )}
    >
      {message?.text}
    </div>
  )
}
