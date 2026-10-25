// Home tab: greeting, who calls him (Pip or Juanito), and the weekly call day and time.
import { useState } from 'react'
import { accountApi, signupApi } from '../../api'
import { HostAvatar } from '../../art/hosts'
import { DAYS, HOSTS, TIME_PRESETS, browserTimezone, dayName, errorText, formatHour } from '../../copy'
import { HOME } from '../../copy/account'
import { Button, Card, ErrorText, PillChoices, Toast, cx } from '../../ui/controls'

const H2 = 'text-subhead'
const DAY_OPTIONS = DAYS.map((d) => ({ value: d.id, label: d.short, aria: d.name }))

const hostName = (id) => (HOSTS[id] || HOSTS.pip).name

/** Host cards + an in-page "Switch to …?" confirm before saving. */
function HostCard({ elderId, token, current, onSaved }) {
  const [picked, setPicked] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changing = picked !== current

  const pick = (id) => {
    setPicked(id)
    setError('')
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      await signupApi.setCharacter(elderId, token, picked)
      onSaved(picked)
    } catch (e) {
      console.error('setCharacter failed', e.code || 'error')
      setError(errorText(e)) // keep their choice so they can try again
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card aria-labelledby="host-title">
      <h2 id="host-title" className={H2}>
        {HOME.hostTitle}
      </h2>
      <fieldset className="w-full min-w-0">
        <legend className="sr-only">{HOME.chooseHost}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(HOSTS).map(([id, host]) => (
            <label
              key={id}
              className={cx(
                'flex cursor-pointer flex-col items-center gap-2 rounded-card border-[3px] px-5 py-7 text-center transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-4 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ink',
                picked === id ? 'border-rose bg-blush' : 'border-line bg-white hover:border-pink',
              )}
            >
              <input type="radio" name="host" value={id} checked={picked === id} onChange={() => pick(id)} className="sr-only" />
              <HostAvatar id={id} />
              <span className="font-display text-[1.875rem] leading-tight">{host.name}</span>
              <span>{HOME.callsIn(host.languageName)}</span>
              {current === id && (
                <span className="tag self-center">
                  {HOME.currentHost}
                </span>
              )}
            </label>
          ))}
        </div>
      </fieldset>
      {/* Live region stays mounted (sr-only when empty, so no extra gap) so the question is read out. */}
      <div aria-live="polite" className={changing ? 'w-full' : 'sr-only'}>
        {changing && (
          <div className="flex w-full flex-col gap-4 rounded-inset border-2 border-pink bg-blush p-6">
            <p className="font-display text-lg font-semibold leading-snug">
              {HOME.switchTo(hostName(picked), HOSTS[picked]?.languageName)}
            </p>
            <ErrorText>{error}</ErrorText>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
              <Button small busy={busy} busyLabel={HOME.saving} onClick={save}>
                {HOME.save}
              </Button>
              <Button small variant="secondary" disabled={busy} onClick={() => pick(current)}>
                {HOME.cancel}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

/** Day and time pills, a live summary, and Save. */
function ScheduleCard({ elderId, token, profile, host, onSaved }) {
  const [day, setDay] = useState(profile.callDay || 'tuesday')
  const [hour, setHour] = useState(profile.callHour ?? 11)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // A saved hour that isn't a preset gets its own pill so it shows as selected.
  const hours = TIME_PRESETS.map((t) => t.hour)
  if (profile.callHour != null && !hours.includes(profile.callHour)) hours.push(profile.callHour)
  const timeOptions = hours.sort((a, b) => a - b).map((h) => ({ value: h, label: formatHour(h) }))

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const timezone = profile.timezone || browserTimezone()
    try {
      await accountApi.setSchedule(elderId, token, day, hour, timezone)
      onSaved({ callDay: day, callHour: hour, timezone })
    } catch (err) {
      console.error('setSchedule failed', err.code || 'error')
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card aria-labelledby="schedule-title">
      <h2 id="schedule-title" className={H2}>
        {HOME.scheduleTitle(host)}
      </h2>
      <form noValidate onSubmit={submit} className="flex w-full flex-col items-start gap-7">
        <PillChoices name="day" legend={HOME.day} options={DAY_OPTIONS} value={day} onChange={setDay} />
        <PillChoices name="time" legend={HOME.time} options={timeOptions} value={hour} onChange={setHour} />
        <p aria-live="polite" className="w-full rounded-inset bg-sage-tint px-5 py-4 font-display text-lg leading-snug">
          {HOME.summary(host, dayName(day), formatHour(hour))}
        </p>
        <Button type="submit" busy={busy} busyLabel={HOME.saving}>
          {HOME.save}
        </Button>
        <ErrorText>{error}</ErrorText>
      </form>
    </Card>
  )
}

export default function HomeTab({ elderId, token, profile, onChange }) {
  const [toast, setToast] = useState(null)
  const say = (text) => setToast({ text, id: Date.now() })
  const host = hostName(profile.characterId)
  const scheduled = profile.callDay && profile.callHour != null

  return (
    <>
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-heading">{HOME.greeting(profile.name, new Date().getHours())}</h1>
        <p className="max-w-[40rem] text-lg">
          {scheduled ? HOME.callsEvery(host, dayName(profile.callDay), formatHour(profile.callHour)) : HOME.noSchedule(host)}
        </p>
      </div>
      <HostCard
        elderId={elderId}
        token={token}
        current={profile.characterId}
        onSaved={(characterId) => {
          onChange({ characterId })
          say(HOME.hostSaved(hostName(characterId)))
        }}
      />
      <ScheduleCard
        elderId={elderId}
        token={token}
        profile={profile}
        host={host}
        onSaved={(patch) => {
          onChange(patch)
          say(HOME.scheduleSaved(host, dayName(patch.callDay), formatHour(patch.callHour)))
        }}
      />
      <Toast message={toast} />
    </>
  )
}
