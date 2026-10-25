// Home tab: greeting, who calls him (his host), the weekly call day and time, and where his
// stories go (connect, or reconnect an account that stopped working).
import { useState } from 'react'
import { CallUsLine } from '../../ui/CallUsLine'
import { accountApi } from '../../api'
import { DAYS, HOSTS, TIME_PRESETS, browserTimezone, dayName, errorText, formatHour, hostForLanguage } from '../../copy'
import { HOME } from '../../copy/account'
import { accountsCopy } from '../../copy/accounts'
import { CheckMark } from '../../art/setup'
import { BlueskyConnect } from '../setup/BlueskyConnect'
import { OAuthConnect } from '../setup/OAuthConnect'
import { Button, Card, ErrorText, PillChoices, Toast, cx } from '../../ui/controls'
import HostCard from './HostCard'
import { go } from '../../lib/route'
import { unfinishedSetup } from '../../lib/setupProgress'

const H2 = 'text-subhead'
const DAY_OPTIONS = DAYS.map((d) => ({ value: d.id, label: d.short, aria: d.name }))

/** A known host id: old or unknown ids fall back to the language's default (Daniel if no language). */
const knownHost = (profile) => (HOSTS[profile.characterId] ? profile.characterId : hostForLanguage(profile.language))

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

const NAMES = { bluesky: 'Bluesky', threads: 'Threads', x: 'X' }

/**
 * His Bluesky / Threads / X accounts. One that's missing or stopped working (invalid) can be
 * (re)connected with his sign-up token; a working one stays as it is (the backend locks it).
 */
function AccountsCard({ elderId, token, accounts, onSaved }) {
  const A = accountsCopy()
  const P = A.page
  const [open, setOpen] = useState(false)
  const state = (id) => accounts.find((a) => a.platform === id) || { platform: id, status: 'none' }
  const bluesky = state('bluesky')
  const oauthOpen = ['threads', 'x'].filter((id) => state(id).status !== 'connected')
  const line = (a) =>
    a.status === 'connected' ? P.connected(NAMES[a.platform], a.handle) : a.status === 'invalid' ? P.invalid(NAMES[a.platform]) : P.none(NAMES[a.platform])

  return (
    <Card aria-labelledby="accounts-title">
      <h2 id="accounts-title" className={H2}>
        {P.title}
      </h2>
      <ul className="m-0 flex w-full list-none flex-col gap-3 p-0">
        {accounts.map((a) => (
          <li key={a.platform} className={cx('flex items-start gap-3', a.status === 'invalid' && 'font-bold text-alert')}>
            {a.status === 'connected' && <CheckMark className="h-7 w-7 flex-none" fill="#8FAE9B" />}
            <span>{line(a)}</span>
          </li>
        ))}
      </ul>
      {bluesky.status !== 'connected' &&
        (open ? (
          <div className="flex w-full flex-col gap-4 rounded-inset border border-line p-5 sm:p-6">
            <BlueskyConnect
              idPrefix="home-bsky"
              words={A.bluesky}
              elderId={elderId}
              token={token}
              connectLabel={bluesky.status === 'invalid' ? P.reconnect('Bluesky') : P.connect('Bluesky')}
              onDone={(res) => {
                setOpen(false)
                onSaved('bluesky', res.status === 'saved' ? res.handle : bluesky.handle)
              }}
            />
            <Button variant="link" small onClick={() => setOpen(false)}>
              {P.cancel}
            </Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {bluesky.status === 'invalid' ? P.reconnect('Bluesky') : P.connect('Bluesky')}
          </Button>
        ))}
      {oauthOpen.length > 0 && (
        <OAuthConnect
          words={A.oauth}
          elderId={elderId}
          token={token}
          only={oauthOpen}
          labels={Object.fromEntries(oauthOpen.filter((id) => state(id).status === 'invalid').map((id) => [id, P.reconnect(NAMES[id])]))}
        />
      )}
    </Card>
  )
}

export default function HomeTab({ elderId, token, profile, onChange }) {
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
      {unfinishedSetup(elderId) && (
        <Card aria-labelledby="finish-setup-title">
          <h2 id="finish-setup-title" className={H2}>
            {HOME.finishSetupTitle}
          </h2>
          <p>{HOME.finishSetupLead}</p>
          <Button onClick={() => go('/setup')}>{HOME.finishSetup}</Button>
        </Card>
      )}
      <HostCard
        elderId={elderId}
        token={token}
        current={hostId}
        onSaved={(characterId) => {
          onChange({ characterId })
          say(HOME.hostSaved(HOSTS[characterId].name))
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
      {profile.accounts && (
        <AccountsCard
          elderId={elderId}
          token={token}
          accounts={profile.accounts}
          onSaved={(platform, handle) => {
            onChange({
              accounts: profile.accounts.map((a) => (a.platform === platform ? { platform, status: 'connected', ...(handle ? { handle } : {}) } : a)),
            })
            say(accountsCopy().page.saved(NAMES[platform]))
          }}
        />
      )}
      <Toast message={toast} />
    </>
  )
}
