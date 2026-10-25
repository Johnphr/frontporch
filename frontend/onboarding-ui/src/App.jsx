// Four screens on hash routes: landing (#/), sign in (#/signin), first-time setup (#/setup),
// and his page (#/home, #/posts). His page needs a signed-in elderId; without one it sends
// them to sign in.
import { useEffect } from 'react'
import { isConfigured } from './api'
import { SETUP_NEEDED } from './copy'
import { go, useRoute } from './lib/route'
import { loadSession } from './lib/session'
import Landing from './pages/Landing'
import SignIn from './pages/SignIn'
import Onboarding from './pages/setup/Onboarding'
import Account from './pages/account/Account'
import { Header } from './ui/Header'

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
