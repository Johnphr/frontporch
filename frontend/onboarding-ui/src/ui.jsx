import { useState } from 'react'

export const cx = (...parts) => parts.filter(Boolean).join(' ')

/* ---------- decorative ---------- */

export function TalaveraBand({ position = 'top', className }) {
  const pos =
    position === 'top' ? 'talavera-band-top' : position === 'side' ? 'talavera-band-side' : 'talavera-band-bottom'
  return <div aria-hidden="true" className={cx('talavera-band', pos, className)} />
}

export function Badge({ children }) {
  return (
    <span className="inline-block self-start rounded-full bg-cempasuchil-400 px-4 py-1 text-base font-bold text-[#3F2500]">
      {children}
    </span>
  )
}

/* ---------- icons ---------- */

export function GoogleIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z" />
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  )
}

export function LinkedInIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="#0A66C2" />
      <path fill="#fff" d="M6.9 9.6h2.5V18H6.9zM8.15 5.6a1.45 1.45 0 110 2.9 1.45 1.45 0 010-2.9zM10.9 9.6h2.4v1.15h.04c.34-.64 1.17-1.32 2.4-1.32 2.57 0 3.04 1.69 3.04 3.88V18h-2.5v-4.2c0-1-.02-2.28-1.39-2.28-1.4 0-1.6 1.09-1.6 2.2V18h-2.5z" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" className="mt-0.5 shrink-0">
      <circle cx="12" cy="12" r="11" fill="#A31515" />
      <rect x="11" y="6" width="2" height="8" rx="1" fill="#fff" />
      <circle cx="12" cy="17.5" r="1.3" fill="#fff" />
    </svg>
  )
}

/* ---------- buttons ---------- */

const BUTTON_BASE =
  'flex min-h-touch w-full items-center justify-center gap-3 rounded-2xl border-2 px-5 text-xl font-bold ' +
  'transition duration-150 active:translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60'

const BUTTON_VARIANTS = {
  primary: 'border-rosa-600 bg-rosa-600 text-white hover:border-rosa-700 hover:bg-rosa-700',
  secondary: 'border-tinta-900 bg-white text-tinta-900 hover:bg-lino-100',
  quiet: 'border-tinta-700 bg-transparent text-tinta-900 underline underline-offset-4 hover:bg-lino-50',
}

export function Button({ variant = 'primary', icon, children, className, type = 'button', ...rest }) {
  return (
    <button type={type} className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className)} {...rest}>
      {icon}
      <span>{children}</span>
    </button>
  )
}

export function BackButton({ children, ...rest }) {
  return (
    <button
      type="button"
      className="inline-flex min-h-touch items-center gap-2 self-start rounded-xl px-2 text-xl font-bold text-talavera-700 underline underline-offset-4 hover:text-talavera-900"
      {...rest}
    >
      <span aria-hidden="true">←</span>
      {children}
    </button>
  )
}

export function LangToggle({ label, ariaLabel, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="inline-flex min-h-touch items-center rounded-2xl border-2 border-talavera-700 bg-lino-50 px-5 text-lg font-bold text-talavera-700 hover:bg-lino-100 active:translate-y-0.5"
    >
      {label}
    </button>
  )
}

/* ---------- choices ---------- */

// Native radios styled as big cards (keyboard + screen readers work as with any radio group).
// options: [{ value, label, description?, badge? }]
export function RadioCards({ name, legend, options, value, onChange, error }) {
  const errId = `${name}-err`
  return (
    <fieldset className="flex flex-col gap-3" aria-describedby={error ? errId : undefined}>
      <legend className="mb-2 text-lg font-bold">{legend}</legend>
      {options.map((o) => {
        const checked = value === o.value
        return (
          <label
            key={o.value}
            className={cx(
              'flex min-h-touch cursor-pointer items-start gap-4 rounded-2xl border-2 bg-white p-4 transition duration-150',
              'focus-within:outline focus-within:outline-4 focus-within:outline-offset-2 focus-within:outline-talavera-600',
              checked ? 'border-rosa-600 bg-rosa-100' : 'border-tinta-700 hover:bg-lino-100',
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={checked}
              onChange={() => onChange(o.value)}
              className="mt-1 h-7 w-7 shrink-0 accent-rosa-600"
            />
            <span className="flex flex-col gap-1">
              <span className="text-xl font-bold text-tinta-900">{o.label}</span>
              {o.badge && <span className="text-lg font-bold text-talavera-700">{o.badge}</span>}
              {o.description && <span className="text-lg text-tinta-700">{o.description}</span>}
            </span>
          </label>
        )
      })}
      {error && (
        <p id={errId} role="alert" className="flex items-start gap-2 text-lg font-bold text-alerta-700">
          <AlertIcon />
          <span>{error}</span>
        </p>
      )}
    </fieldset>
  )
}

/* ---------- progress ---------- */

export function StepHeader({ step, total = 3, label, title }) {
  return (
    <div className="flex flex-col gap-3">
      <div role="img" aria-label={label} className="flex gap-2">
        {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
          <span
            key={n}
            className={cx('h-2 flex-1 rounded-full', n <= step ? 'bg-rosa-600' : 'bg-lino-300')}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Badge>{label}</Badge>
        {title && <span className="text-lg font-bold text-talavera-700">{title}</span>}
      </div>
    </div>
  )
}

/* ---------- form fields ---------- */

const INPUT_CLASS =
  'min-h-touch w-full rounded-2xl border-2 bg-white px-4 text-xl text-tinta-900 placeholder:text-tinta-700/70'

export function FieldShell({ id, label, hint, error, children }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-lg font-bold">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-lg text-tinta-700">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} role="alert" className="flex items-start gap-2 text-lg font-bold text-alerta-700">
          <AlertIcon />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

const describedBy = (id, hint, error) => (error ? `${id}-err` : hint ? `${id}-hint` : undefined)

export function TextField({ id, label, hint, error, className, ...rest }) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cx(INPUT_CLASS, error ? 'border-alerta-700' : 'border-tinta-700', className)}
        {...rest}
      />
    </FieldShell>
  )
}

export function PasswordField({ id, label, hint, error, labels, ...rest }) {
  const [shown, setShown] = useState(false)
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <div className="relative">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy(id, hint, error)}
          className={cx(INPUT_CLASS, 'pr-32', error ? 'border-alerta-700' : 'border-tinta-700')}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-label={shown ? labels.hideAria : labels.showAria}
          className="absolute inset-y-0 right-0 w-28 rounded-r-2xl border-l-2 border-tinta-700 text-lg font-bold text-talavera-700 hover:bg-lino-100"
        >
          {shown ? labels.hide : labels.show}
        </button>
      </div>
    </FieldShell>
  )
}

export function SelectField({ id, label, children, ...rest }) {
  return (
    <FieldShell id={id} label={label}>
      <select id={id} className={cx(INPUT_CLASS, 'border-tinta-700')} {...rest}>
        {children}
      </select>
    </FieldShell>
  )
}

export function ErrorBanner({ children }) {
  if (!children) return null
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-2xl border-2 border-alerta-700 bg-alerta-100 p-4 text-lg font-bold text-alerta-700"
    >
      <AlertIcon />
      <span>{children}</span>
    </div>
  )
}

export function Note({ children }) {
  return (
    <p className="rounded-2xl border-2 border-cempasuchil-400 bg-[#FFF4DC] p-4 text-lg">{children}</p>
  )
}
