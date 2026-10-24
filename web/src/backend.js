// Calls to the Convex backend (convex/signup.ts).
// anyApi builds function references by name, so this works without the generated types.
import { useMemo } from 'react'
import { useConvex } from 'convex/react'
import { anyApi } from 'convex/server'

const TIMEOUT_MS = 30000
const signup = anyApi.signup

// The Convex client waits forever while offline. Give up after a while so the screen can say so.
function withTimeout(promise) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('Convex request timed out')
      e.code = 'NETWORK'
      reject(e)
    }, TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function call(name, promise) {
  try {
    return await withTimeout(promise)
  } catch (e) {
    console.error(`signup:${name} failed`, e)
    throw e
  }
}

export function useBackend() {
  const convex = useConvex()
  return useMemo(
    () => ({
      /** -> Array<{ id, name, language: 'en' | 'es', description }> */
      listCharacters: () => call('listCharacters', convex.query(signup.listCharacters, {})),
      /** { name, phone (E.164), language } -> elderId */
      register: (args) => call('register', convex.mutation(signup.register, args)),
      /** { elderId, characterId } -> null */
      setCharacter: (args) => call('setCharacter', convex.mutation(signup.setCharacter, args)),
      /** { elderId, url } -> null */
      setLinkedin: (args) => call('setLinkedin', convex.mutation(signup.setLinkedin, args)),
      /** { elderId } -> { ok: true } | { ok: false, reason, message } */
      requestCall: (args) => call('requestCall', convex.action(signup.requestCall, args)),
    }),
    [convex],
  )
}
