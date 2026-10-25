// Four screens on hash routes: landing (#/), sign in (#/signin: phone number), first-time setup
// (#/setup), and his page (#/home, #/posts). His page needs a signed-in elderId + token; without
// them it sends them to sign in.
import { useEffect, useState } from 'react'
import { isConfigured } from './api'
import { SETUP_NEEDED } from './copy'
import { accountsCopy } from './copy/accounts'
import { go, useRoute } from './lib/route'
import { handOffOAuthResult, readOAuthReturn } from './lib/oauthReturn'
import { OAUTH_FROM_KEY, loadSession } from './lib/session'
import { ACCOUNTS_STEP, loadProgress } from './lib/setupProgress'
import Landing from './pages/Landing'
import SignIn from './pages/SignIn'
import Onboarding from './pages/setup/Onboarding'
import Account from './pages/account/Account'
import { Header } from './ui/Header'

// Back from Threads / X (?connected= / ?connect_error=), read once at start-up. This is usually the
// new tab "Connect" opened: the result goes to the tab that started the trip and this one closes.
// If no tab takes it: back where the trip started here. Setup (its accounts step shows the result;
// progress is in localStorage), else his page.
const oauthBack = readOAuthReturn()
const handOff = oauthBack ? handOffOAuthResult(oauthBack) : null

function routeBack() {
  let from = null
  try {
    from = localStorage.getItem(OAUTH_FROM_KEY)
    localStorage.removeItem(OAUTH_FROM_KEY)
  } catch {
    /* storage unavailable */
  }
  const inSetup = from !== 'home' && loadProgress()?.step === ACCOUNTS_STEP
  if (inSetup) go('/setup')
  else if (loadSession().elderId) go('/home')
}

/** null while the result is handed off; 'closing' once the other tab took it; 'here' otherwise. */
function useOAuthTrip() {
  const [trip, setTrip] = useState(handOff ? null : 'here')
  useEffect(() => {
    if (!handOff) return
    handOff.then((taken) => {
      if (taken) {
        setTrip('closing')
        window.close() // a tab the site opened can close itself; if not, the message says so
      } else {
        routeBack()
        setTrip('here')
      }
    })
  }, [])
  return trip
}

export default function App() {
  const trip = useOAuthTrip()
  const route = useRoute()
  const needsAccount = route === '/home' || route === '/posts'
  const signedOut = needsAccount && !loadSession().elderId

  useEffect(() => {
    if (signedOut) go('/signin')
  }, [signedOut])

  if (!trip) return null
  if (trip === 'closing') return <OAuthTabDone back={oauthBack} />
  if (route === '/') return <Landing />
  if (!isConfigured) return <SetupNeeded />
  if (route === '/signin') return <SignIn />
  if (route === '/setup') return <Onboarding />
  if (signedOut) return null
  return <Account tab={route === '/posts' ? 'posts' : 'home'} />
}

/** The connect tab, after handing the result back (if the browser doesn't let it close itself). */
function OAuthTabDone({ back }) {
  const O = accountsCopy().oauth
  const name = back.platform === 'x' ? 'X' : 'Threads'
  return (
    <>
      <Header />
      <main id="main" className="mx-auto flex max-w-[40rem] flex-col gap-4 px-5 py-16">
        <h1 className="text-[2.5rem]">{back.ok ? O.connected(name) : O.notConnected(name)}</h1>
        <p>{O.closeTab}</p>
      </main>
    </>
  )
}

/** Shown when the site was built without VITE_CONVEX_URL, instead of a broken form. */
function SetupNeeded() {
  return (
    <>
      <Header />
      <main id="main" className="mx-auto flex max-w-[40rem] flex-col gap-4 px-5 py-16">
        <h1 className="text-[2.5rem]">{SETUP_NEEDED.title}</h1>
        <p>{SETUP_NEEDED.lead}</p>
      </main>
    </>
  )
}
