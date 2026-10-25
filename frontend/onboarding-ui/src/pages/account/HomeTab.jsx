// Home tab: greeting, who calls him (his host), and the weekly call day and time.
import { useState } from 'react'
import { CallUsLine } from '../../ui/CallUsLine'
import { accountApi } from '../../api'
import { DAYS, HOSTS, TIME_PRESETS, browserTimezone, dayName, errorText, formatHour, hostForLanguage } from '../../copy'
import { HOME } from '../../copy/account'
import { Button, Card, ErrorText, PillChoices, Toast } from '../../ui/controls'
import HostCard from './HostCard'

const H2 = 'text-subhead'
const DAY_OPTIONS = DAYS.map((d) => ({ value: d.id, label: d.short, aria: d.name }))

/** A known host id: old or unknown ids fall back to the language's default (Daniel if no language). */
const knownHost = (profile) => (HOSTS[profile.characterId] ? profile.characterId : hostForLanguage(profile.language))

/** Day and time pills, a live summary, and Save. */
function ScheduleCard({ elderId, profile, host, onSaved }) {
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
      await accountApi.setSchedule(elderId, day, hour, timezone)
      onSaved({ callDay: day, callHour: hour, timezone })
    } catch (err) {
      console.error('setSchedule failed', err)
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

export default function HomeTab({ elderId, profile, onChange }) {
  const [toast, setToast] = useState(null)
  const say = (text) => setToast({ text, id: Date.now() })
  const hostId = knownHost(profile)
  const host = HOSTS[hostId].name
  const scheduled = profile.callDay && profile.callHour != null

  return (
    <>
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-heading">{HOME.greeting(profile.name, new Date().getHours())}</h1>
        <p className="max-w-[40rem] text-lg">
          {scheduled ? HOME.callsEvery(host, dayName(profile.callDay), formatHour(profile.callHour)) : HOME.noSchedule(host)}
        </p>
        <CallUsLine host={host} />
      </div>
      <HostCard
        elderId={elderId}
        current={hostId}
        onSaved={(characterId) => {
          onChange({ characterId })
          say(HOME.hostSaved(HOSTS[characterId].name))
        }}
      />
      <ScheduleCard
        elderId={elderId}
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
