// Step 6 (after Review saved the sign-up): his own accounts. Bluesky with a handle + app password
// (BlueskyConnect.jsx), Threads and X with OAuth (OAuthConnect.jsx). All optional. Finish
// connects Bluesky first if its fields are filled in, then asks for the first call.
import { useRef, useState } from 'react'
import { accountsCopy } from '../../copy/accounts'
import { CheckMark, ProfileArt } from '../../art/setup'
import { Button } from '../../ui/controls'
import { BlueskyConnect } from './BlueskyConnect'
import { OAuthConnect } from './OAuthConnect'
import { ART, StepCard } from './steps'

export default function AccountsStep({ data, set, words, headingRef, elderId, token, onFinish, beforeLeave }) {
  const A = accountsCopy()
  const B = A.bluesky
  const form = useRef(null)
  const [finishing, setFinishing] = useState(false)
  const bluesky = data.bluesky // { status: 'saved', handle } | { status: 'locked' } | undefined

  async function finish(skip) {
    if (!skip && !bluesky && form.current?.hasInput()) {
      if (!(await form.current.connect())) return
    }
    form.current?.clear()
    setFinishing(true)
    await onFinish() // never throws; moves on to Done
  }

  return (
    <StepCard
      step={6}
      art={<ProfileArt className={ART} />}
      title={A.title(data.who === 'helper', words.n)}
      headingRef={headingRef}
      onSubmit={() => finish(false)}
      nextLabel={A.finish}
      busy={finishing}
      busyLabel={A.finishing}
      actions={
        <Button variant="link" small disabled={finishing} onClick={() => finish(true)}>
          {A.skip}
        </Button>
      }
    >
      <p className="flex items-center gap-3 font-bold">
        <CheckMark className="h-8 w-8 flex-none" fill="#8FAE9B" />
        {A.saved}
      </p>
      <p>{A.lead(data.who === 'helper')}</p>

      <section aria-labelledby="bsky-title" className="flex w-full flex-col gap-5 border-t border-line pt-6">
        <h2 id="bsky-title" className="text-subhead">
          {B.title}
        </h2>
        {bluesky ? (
          <p aria-live="polite" className="flex items-center gap-3 rounded-inset bg-sage-tint px-5 py-4">
            <CheckMark className="h-8 w-8 flex-none" fill="#8FAE9B" />
            {bluesky.status === 'saved' ? B.connected(bluesky.handle) : B.locked}
          </p>
        ) : (
          <BlueskyConnect ref={form} words={B} elderId={elderId} token={token} disabled={finishing} onDone={(state) => set({ bluesky: state })} />
        )}
      </section>

      <section aria-labelledby="oauth-title" className="flex w-full flex-col gap-5 border-t border-line pb-2 pt-6">
        <h2 id="oauth-title" className="text-subhead">
          {A.oauth.title}
        </h2>
        <OAuthConnect words={A.oauth} elderId={elderId} token={token} beforeLeave={beforeLeave} />
      </section>
    </StepCard>
  )
}
