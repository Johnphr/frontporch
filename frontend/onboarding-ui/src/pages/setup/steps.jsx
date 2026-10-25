// Setup steps 1-5 (design-mockups/onboarding-c.html). Each is a form card: art, h1 (focused by
// Onboarding when the step opens), fields, then Continue. Props: data + set (the shared answers),
// words (setupCopy), headingRef, onNext, nextLabel.
import { useRef, useState } from 'react'
import { looksLikeLinkedInProfile } from '../../api'
import { DAYS, HOSTS, TIME_PRESETS, dayName, formatHour, hostForLanguage } from '../../copy'
import { SETUP } from '../../copy/setup'
import {
  CalendarArt,
  CheckMark,
  ClockIcon,
  HelperAvatar,
  JuanitoHost,
  LanguageArt,
  NameArt,
  PipHost,
  PorchArt,
  ProfileArt,
  SelfAvatar,
} from '../../art/setup'
import { Button, Card, ChoiceCard, ErrorText, PillChoices, SelectField, TextField } from '../../ui/controls'

export const ART = 'w-full max-w-[13rem] self-center'
const AVATAR = 'h-14 w-14 flex-none rounded-full sm:h-[4.5rem] sm:w-[4.5rem]'

/** The card every step sits in. Extra `actions` go after the submit button. */
export function StepCard({ step, art, title, headingRef, onSubmit, nextLabel, busy, busyLabel, actions, children }) {
  return (
    <Card
      as="form"
      noValidate
      className="shadow-card"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      {art}
      <h1 ref={headingRef} tabIndex={-1} className="text-title">
        {step && <span className="sr-only">{SETUP.stepOf(step)}. </span>}
        {title}
      </h1>
      {children}
      <div className="flex w-full flex-wrap items-center gap-x-6 gap-y-4">
        <Button type="submit" busy={busy} busyLabel={busyLabel}>
          {nextLabel}
        </Button>
        {actions}
      </div>
    </Card>
  )
}

const focusFirstInput = (el) => el?.querySelector('input')?.focus()

/** Step 1: for myself, or helping someone else. */
export function WhoStep({ data, set, words, onNext, ...frame }) {
  const [error, setError] = useState('')
  const group = useRef(null)
  function submit() {
    if (data.who) return onNext()
    setError(SETUP.who.missing)
    focusFirstInput(group.current)
  }
  const choose = (who) => {
    set({ who })
    setError('')
  }
  return (
    <StepCard {...frame} step={1} art={<PorchArt className={ART} />} title={SETUP.who.title} onSubmit={submit}>
      <p>{SETUP.who.lead}</p>
      <fieldset ref={group} aria-describedby={error ? 'who-error' : undefined} className="flex w-full min-w-0 flex-col gap-4">
        <legend className="mb-3 font-bold">{SETUP.who.legend}</legend>
        <ChoiceCard
          name="who"
          value="self"
          checked={data.who === 'self'}
          onChange={choose}
          invalid={!!error}
          title={SETUP.who.self}
          sub={words.selfSub}
          art={<SelfAvatar className={AVATAR} />}
        />
        <ChoiceCard
          name="who"
          value="helper"
          checked={data.who === 'helper'}
          onChange={choose}
          invalid={!!error}
          title={SETUP.who.helper}
          sub={SETUP.who.helperSub}
          art={<HelperAvatar className={AVATAR} />}
        />
        <ErrorText id="who-error">{error}</ErrorText>
      </fieldset>
    </StepCard>
  )
}

/** Step 2: the name the host uses on every call. */
export function NameStep({ data, set, words, onNext, ...frame }) {
  const [error, setError] = useState('')
  function submit() {
    if (data.name.trim()) return onNext()
    setError(words.nameMissing)
    document.getElementById('name')?.focus()
  }
  return (
    <StepCard {...frame} step={2} art={<NameArt className={ART} />} title={words.nameTitle} onSubmit={submit}>
      <TextField
        id="name"
        label={words.nameLabel}
        hint={words.nameHint}
        error={error}
        type="text"
        autoComplete="name"
        maxLength={100}
        value={data.name}
        onChange={(e) => {
          set({ name: e.target.value })
          setError('')
        }}
      />
    </StepCard>
  )
}

/** Step 3: language, which also picks the host. */
export function LanguageStep({ data, set, words, onNext, ...frame }) {
  const hostId = hostForLanguage(data.language)
  const choose = (language) => set({ language })
  return (
    <StepCard {...frame} step={3} art={<LanguageArt className={ART} />} title={words.langTitle} onSubmit={onNext}>
      <fieldset aria-describedby="lang-hint" className="flex w-full min-w-0 flex-col gap-4">
        <legend className="mb-1 font-bold">{SETUP.language.legend}</legend>
        <p id="lang-hint" className="text-sm text-muted">
          {SETUP.language.hint}
        </p>
        <ChoiceCard name="language" value="en" checked={data.language === 'en'} onChange={choose} title={SETUP.language.en} sub={SETUP.language.enSub} />
        <ChoiceCard name="language" value="es" checked={data.language === 'es'} onChange={choose} title={SETUP.language.es} sub={SETUP.language.esSub} />
      </fieldset>
      <div aria-live="polite" className="grid w-full gap-x-6 gap-y-4 rounded-inset border border-line bg-blush p-6 min-[544px]:grid-cols-[7rem_minmax(0,1fr)] min-[544px]:items-start">
        {hostId === 'juanito' ? <JuanitoHost className="w-28" /> : <PipHost className="w-28" />}
        <div className="flex min-w-0 flex-col items-start gap-4">
          <span className="tag">
            {words.hostTag}
          </span>
          <h2 className="text-[2rem]">{HOSTS[hostId].name}</h2>
          <p>{words.hostDesc}</p>
          <p className="border-l-4 border-pink pl-5 font-display italic leading-snug">{words.hostLine}</p>
          {hostId === 'juanito' && <p className="text-sm text-muted">{words.hostTranslation}</p>}
        </div>
      </div>
    </StepCard>
  )
}

/** Step 4: weekly day and hour (presets, or any hour from the list). Times are in the browser's zone. */
export function WhenStep({ data, set, words, onNext, ...frame }) {
  const isPreset = TIME_PRESETS.some((p) => p.hour === data.callHour)
  return (
    <StepCard {...frame} step={4} art={<CalendarArt className={ART} />} title={words.whenTitle} onSubmit={onNext}>
      <p>{SETUP.when.lead}</p>
      <PillChoices
        name="callDay"
        legend={SETUP.when.day}
        options={DAYS.map((d) => ({ value: d.id, label: d.short, aria: d.name }))}
        value={data.callDay}
        onChange={(callDay) => set({ callDay })}
      />
      <fieldset className="w-full min-w-0">
        <legend className="mb-3 font-bold">{SETUP.when.time}</legend>
        <div className="grid gap-3 min-[480px]:grid-cols-2">
          {TIME_PRESETS.map((p) => (
            <ChoiceCard
              key={p.hour}
              name="preset"
              value={p.hour}
              checked={data.callHour === p.hour}
              onChange={(callHour) => set({ callHour })}
              title={p.label}
              sub={formatHour(p.hour)}
            />
          ))}
        </div>
      </fieldset>
      <SelectField
        id="hour-other"
        label={SETUP.when.other}
        value={isPreset ? '' : String(data.callHour)}
        onChange={(e) => e.target.value !== '' && set({ callHour: Number(e.target.value) })}
      >
        <option value="">{SETUP.when.otherNone}</option>
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>
            {formatHour(h)}
          </option>
        ))}
      </SelectField>
      <p aria-live="polite" className="flex w-full items-center gap-4 rounded-inset bg-sage-tint px-6 py-5 font-display text-lg leading-snug">
        <ClockIcon />
        <span>{words.whenSummary(dayName(data.callDay), formatHour(data.callHour))}</span>
      </p>
    </StepCard>
  )
}

/** Step 5: optional LinkedIn profile. */
export function LinkedinStep({ data, set, words, onNext, ...frame }) {
  const [error, setError] = useState('')
  function submit() {
    const value = data.linkedin.trim()
    if (value && !looksLikeLinkedInProfile(value)) {
      setError(SETUP.linkedin.invalid)
      document.getElementById('linkedin')?.focus()
      return
    }
    set({ liStatus: value ? 'url' : 'later' })
    onNext()
  }
  const skip = (liStatus) => {
    set({ liStatus, linkedin: '' })
    setError('')
    onNext()
  }
  return (
    <StepCard
      {...frame}
      step={5}
      art={<ProfileArt className={ART} />}
      title={words.liTitle}
      onSubmit={submit}
      actions={
        <>
          <Button variant="link" small onClick={() => skip('none')}>
            {words.liNone}
          </Button>
          <Button variant="link" small onClick={() => skip('later')}>
            {SETUP.linkedin.later}
          </Button>
        </>
      }
    >
      <p>{SETUP.linkedin.lead}</p>
      <TextField
        id="linkedin"
        label={words.liLabel}
        hint={SETUP.linkedin.hint}
        error={error}
        type="text"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        value={data.linkedin}
        onChange={(e) => {
          set({ linkedin: e.target.value })
          setError('')
        }}
      />
      <div className="flex w-full items-start gap-4 rounded-inset bg-sage-tint px-6 py-5 text-sm">
        <CheckMark />
        <p>
          <strong className="block text-[1.25rem]">{SETUP.linkedin.reassureTitle}</strong> {words.liReassure}
        </p>
      </div>
    </StepCard>
  )
}
