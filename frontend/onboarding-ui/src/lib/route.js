// Hash routes (#/, #/signin, #/setup, #/home, #/posts): no router package, and static hosting
// (vercel.json) needs no rewrites.
import { useEffect, useState } from 'react'

export const ROUTES = ['/', '/signin', '/setup', '/home', '/posts']

function current() {
  const path = window.location.hash.replace(/^#/, '') || '/'
  return ROUTES.includes(path) ? path : '/'
}

/** The current route; re-renders when the hash changes. */
export function useRoute() {
  const [route, setRoute] = useState(current)
  useEffect(() => {
    const onChange = () => {
      setRoute(current())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

/** Go to a route, e.g. go('/home'). */
export function go(path) {
  window.location.hash = path === '/' ? '' : path
}
