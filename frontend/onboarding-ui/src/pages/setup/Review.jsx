// Step 6: everything at a glance, "Change" links back to each step, the phone edited in place, and
// one "Finish and call now" button (finish.js) with a heads-up that the phone rings right away.
// The phone editor starts open, empty, when there is no phone yet (email sign-in) or when a helper
// would otherwise have their own sign-in number called; Finish then needs a valid number.
import { useEffect, useRef, useState } from 'react'
import { HOSTS, dayName, errorText, formatHour } from '../../copy'
import { SETUP, zoneName } from '../../copy/setup'
import { showPhone } from '../../copy/signin'
import { COUNTRIES, digitsOf, formatNational, splitE164, toE164 } from '../../phone'
import { ClipboardArt } from '../../art/setup'
import { Button, ErrorText, SelectField, TextField } from '../../ui/controls'
import { finishSetup } from './finish'
import { ART, StepCard } from './steps'

const R = SETUP.review

function Row({ label, value, sub, children }) {
  return (
    <div className="border-b border-line py-4">
      <dt className="text-sm font-bold text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="min-w-0 text-lg leading-snug [overflow-wrap:anywhere]">
          {value}
          {sub && <small className="block text-sm text-muted">{sub}</small>}
        </span>
        {children}
      </dd>
    </div>
  )
}

function ChangeLink({ label = R.change, what, ...rest }) {
  return (
    <Button variant="link" small {...rest}>
      {label}
      <span className="sr-only"> {R.what[what]}</span>
    </Button>
  )
}

export default function Review({ data, set, words, headingRef, signedInPhone, onGoto, onDone }) {
  // A helper signed in with their own number: ask for the other person's instead of calling it.
  const helperOwnPhone = data.who === 'helper' && data.phone === signedInPhone && !data.phoneChecked
  const [editing, setEditing] = useState(!data.phone || helperOwnPhone)
  const [country, setCountry] = useState(() => splitE164(data.phone).country)
  const [national, setNational] = useState('')
  const [phoneError, setPhoneError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const focusAfter = useRef(null) // 'input' | 'button', once the editor opens or closes

  useEffect(() => {
    if (focusAfter.current === 'input') document.getElementById('review-phone')?.focus()
    if (focusAfter.current === 'button') document.getElementById('phone-edit-btn')?.focus()
    focusAfter.current = null
  }, [editing])

  const hostId = data.host
  const day = dayName(data.callDay)
  const time = formatHour(data.callHour)
  const linkedinUrl = data.liStatus === 'url' ? `https://${data.linkedin.trim().replace(/^https?:\/\//i, '')}` : ''
  const linkedinText = linkedinUrl ? linkedinUrl.replace(/^https:\/\//, '') : data.liStatus === 'none' ? R.noLinkedin : R.laterLinkedin

  function openEditor() {
    const saved = splitE164(data.phone)
    setCountry(saved.country)
    setNational(data.phone ? saved.national : '')
    focusAfter.current = 'input'
    setEditing(true)
  }
  function closeEditor() {
    setPhoneError('')
    focusAfter.current = 'button'
    setEditing(false)
  }
  /** The typed number as E.164, or null after showing why not. */
  function readPhone() {
    const digits = digitsOf(national).length
    if (digits === country.digits) return toE164(country, national)
    setPhoneError(digits ? R.phoneShort(country.digits) : R.phoneMissing)
    document.getElementById('review-phone')?.focus()
    return null
  }
  function savePhone() {
    const phone = readPhone()
    if (!phone) return
    set({ phone, phoneChecked: true })
    closeEditor()
  }

  async function finish() {
    let phone = data.phone
    if (editing) {
      phone = readPhone()
      if (!phone) return
      set({ phone, phoneChecked: true })
      setPhoneError('')
      setEditing(false)
    }
    setBusy(true)
    setError(null)
    try {
      const result = await finishSetup({
        name: data.name,
        phone,
        language: data.language,
        hostId,
        callDay: data.callDay,
        callHour: data.callHour,
        linkedinUrl,
      })
      onDone({ ...result, phone })
    } catch (e) {
      console.error('Finishing setup failed', e)
      setError(e)
      setBusy(false)
    }
  }

  return (
    <StepCard
      step={6}
      art={<ClipboardArt className={ART} />}
      title={words.reviewTitle}
      headingRef={headingRef}
      onSubmit={finish}
      nextLabel={words.finishLabel}
      busy={busy}
      busyLabel={R.finishing}
    >
      <p>{words.reviewIntro}</p>
      <dl className="w-full">
        <Row label={R.who} value={words.reviewWho}>
          <ChangeLink what="who" onClick={() => onGoto(1)} />
        </Row>
        <Row label={R.name} value={words.n}>
          <ChangeLink what="name" onClick={() => onGoto(2)} />
        </Row>
        <Row
          label={R.phone}
          value={data.phone && !helperOwnPhone ? showPhone(data.phone) : null}
          sub={data.phone && !editing ? words.phoneNote(data.phone === signedInPhone) : null}
        >
          {!editing && (
            <ChangeLink id="phone-edit-btn" label={R.edit} what="phone" aria-expanded={false} aria-controls="phone-edit" onClick={openEditor} />
          )}
          {editing && (
            <div id="phone-edit" className="flex basis-full flex-col gap-4 pt-3 motion-safe:animate-enter">
              <SelectField
                id="review-country"
                label={R.country}
                autoComplete="tel-country-code"
                value={country.code}
                onChange={(e) => {
                  const next = COUNTRIES.find((c) => c.code === e.target.value)
                  setCountry(next)
                  setNational(formatNational(next, national))
                  setPhoneError('')
                }}
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.dial})
                  </option>
                ))}
              </SelectField>
              <TextField
                id="review-phone"
                label={R.phoneLabel}
                hint={words.phoneHint}
                error={phoneError}
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder={country.example}
                value={national}
                onChange={(e) => {
                  setNational(formatNational(country, e.target.value))
                  setPhoneError('')
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault() // save the number, don't submit the whole form
                  savePhone()
                }}
              />
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <Button small onClick={savePhone}>
                  {R.save}
                </Button>
                {data.phone && !helperOwnPhone && (
                  <Button variant="link" small onClick={closeEditor}>
                    {R.cancel}
                  </Button>
                )}
              </div>
            </div>
          )}
        </Row>
        <Row label={R.lang} value={words.reviewLang(HOSTS[hostId].languageName)}>
          <ChangeLink what="lang" onClick={() => onGoto(3)} />
        </Row>
        <Row label={R.when} value={words.reviewWhen(day, time, zoneName())}>
          <ChangeLink what="when" onClick={() => onGoto(4)} />
        </Row>
        <Row label={R.linkedin} value={linkedinText}>
          <ChangeLink what="linkedin" onClick={() => onGoto(5)} />
        </Row>
      </dl>
      <p className="w-full rounded-inset bg-wash px-5 py-4">{words.callHeadsUp}</p>
      <ErrorText id="finish-error">{errorText(error)}</ErrorText>
    </StepCard>
  )
}
