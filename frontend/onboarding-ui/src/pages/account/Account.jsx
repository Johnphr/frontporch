// His page (#/home, #/posts): header with Sign out, Home/Posts tabs, and the profile loaded once.
// Switching tabs changes the hash; this component stays mounted, so the profile is kept.
import { useEffect, useRef, useState } from 'react'
import { accountApi } from '../../api'
import { NAV } from '../../copy'
import { ACCOUNT } from '../../copy/account'
import { go } from '../../lib/route'
import { clearSession, loadSession } from '../../lib/session'
import { Button, cx } from '../../ui/controls'
import { Header, NAV_ITEM } from '../../ui/Header'
import HomeTab from './HomeTab'
import PostsTab, { LoadError, Loading } from './PostsTab'

const TABS = ['home', 'posts']
const WRAP = 'mx-auto w-full max-w-[56rem] px-5 sm:px-8'

/** Real tabs: role=tab, aria-selected, left/right arrows move between them. Pills on phones. */
function Tabs({ tab, label }) {
  const refs = useRef({})

  const onKeyDown = (e, i) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length]
    go(`/${next}`)
    refs.current[next]?.focus()
  }

  return (
    <div className={WRAP}>
      <div role="tablist" aria-label={label} className="grid grid-cols-2 gap-2 pb-4 sm:flex sm:pb-0">
        {TABS.map((id, i) => {
          const on = id === tab
          return (
            <button
              key={id}
              ref={(el) => (refs.current[id] = el)}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={on}
              aria-controls={on ? `panel-${id}` : undefined}
              tabIndex={on ? 0 : -1}
              onClick={() => go(`/${id}`)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cx(
                'min-h-touch rounded-full border-2 px-4 py-3 font-bold leading-tight transition-colors hover:bg-wash sm:rounded-b-none sm:rounded-t-inset sm:border-0 sm:border-b-4 sm:px-8',
                on ? 'border-rose bg-rose-wash text-rose' : 'border-line text-ink sm:border-transparent',
              )}
            >
              {ACCOUNT.tabs[id]}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SignOut() {
  const signOut = () => {
    clearSession()
    go('/')
  }
  return (
    <button type="button" onClick={signOut} className={NAV_ITEM}>
      {NAV.signOut}
    </button>
  )
}

export default function Account({ tab }) {
  const [elderId] = useState(() => loadSession().elderId)
  const [state, setState] = useState({ status: 'loading' }) // loading | ready | error | missing
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    accountApi.getProfile(elderId).then(
      (profile) => {
        if (!live) return
        if (profile) return setState({ status: 'ready', profile })
        clearSession() // unknown id: this device's sign-in is stale
        setState({ status: 'missing' })
      },
      (error) => {
        console.error('getProfile failed', error)
        if (live) setState({ status: 'error', error })
      },
    )
    return () => {
      live = false
    }
  }, [elderId, attempt])

  if (state.status === 'missing') {
    return (
      <>
        <Header />
        <main id="main" className={cx(WRAP, 'flex flex-col items-start gap-8 py-10 sm:py-16')}>
          <h1 className="text-title">{ACCOUNT.notFound}</h1>
          <Button onClick={() => go('/signin')}>{NAV.signIn}</Button>
        </main>
      </>
    )
  }

  const profile = state.profile
  const onChange = (patch) => setState((s) => ({ ...s, profile: { ...s.profile, ...patch } }))

  return (
    <>
      <Header below={<Tabs tab={tab} label={ACCOUNT.tabsLabel(profile?.name)} />}>
        <SignOut />
      </Header>
      <main id="main" className={cx(WRAP, 'py-10 sm:py-16')}>
        <section id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="flex flex-col gap-8">
          {state.status === 'loading' && <Loading label={ACCOUNT.loading} cards={3} />}
          {state.status === 'error' && <LoadError error={state.error} onRetry={() => setAttempt((a) => a + 1)} />}
          {state.status === 'ready' && tab === 'home' && <HomeTab elderId={elderId} profile={profile} onChange={onChange} />}
          {state.status === 'ready' && tab === 'posts' && <PostsTab elderId={elderId} />}
        </section>
      </main>
    </>
  )
}
