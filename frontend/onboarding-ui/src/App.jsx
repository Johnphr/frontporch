// Four screens on hash routes: landing (#/), sign in (#/signin), first-time setup (#/setup),
// and his page (#/home, #/posts). His page needs a signed-in elderId + sign-up token; without
// them it sends them to sign in.
import { useEffect } from 'react'
import { isConfigured } from './api'
import { SETUP_NEEDED } from './copy'
import { go, useRoute } from './lib/route'
import { readOAuthReturn } from './lib/oauthReturn'
import { OAUTH_FROM_KEY, loadSession } from './lib/session'
import { ACCOUNTS_STEP, loadProgress } from './lib/setupProgress'
import Landing from './pages/Landing'
import SignIn from './pages/SignIn'
import Onboarding from './pages/setup/Onboarding'
import Account from './pages/account/Account'
import { Header } from './ui/Header'

// Back from Threads / X (?connected= / ?connect_error=): back where the trip started. Setup
// (its accounts step shows the result; progress is in localStorage, so a new tab works too),
// else his page. Runs once, before the first render.
if (readOAuthReturn()) {
  let from = null
  try {
    from = localStorage.getItem(OAUTH_FROM_KEY)
    localStorage.removeItem(OAUTH_FROM_KEY)
  } catch {
    /* storage unavailable */
  }
  const inSetup = from !== 'home' && loadProgress()?.step === ACCOUNTS_STEP
  const hash = inSetup ? '#/setup' : loadSession().elderId ? '#/home' : ''
  if (hash) window.history.replaceState(null, '', window.location.pathname + window.location.search + hash)
}

export default function App() {
  const route = useRoute()
  const needsAccount = route === '/home' || route === '/posts'
  const signedOut = needsAccount && !loadSession().elderId

  useEffect(() => {
    if (signedOut) go('/signin')
  }, [signedOut])

  if (route === '/') return <Landing />
  if (!isConfigured) return <SetupNeeded />
  if (route === '/signin') return <SignIn />
  if (route === '/setup') return <Onboarding />
  if (signedOut) return null
  return <Account tab={route === '/posts' ? 'posts' : 'home'} />
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
