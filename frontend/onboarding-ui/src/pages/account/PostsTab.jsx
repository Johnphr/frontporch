// Posts tab: his posts that went out, newest first, a link per platform, and reactions and
// comments summed across platforms.
import { useEffect, useState } from 'react'
import { accountApi } from '../../api'
import { errorText } from '../../copy'
import { ACCOUNT, POSTS } from '../../copy/account'
import { Button, Card, ErrorText } from '../../ui/controls'

/** Calm placeholder cards while something loads. The label is read out. */
export function Loading({ label, cards = 2 }) {
  return (
    <div aria-busy="true" className="flex w-full flex-col gap-6">
      <p role="status" className="sr-only">
        {label}
      </p>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex animate-pulse flex-col gap-4 rounded-card border border-line bg-white p-6 sm:p-10">
          <span className="h-5 w-1/3 rounded-full bg-blush" />
          <span className="h-5 w-full rounded-full bg-blush" />
          <span className="h-5 w-2/3 rounded-full bg-blush" />
        </div>
      ))}
    </div>
  )
}

/** Error card with the message and a "Try again" button. */
export function LoadError({ error, onRetry }) {
  return (
    <Card className="w-full">
      <ErrorText>{errorText(error)}</ErrorText>
      <Button variant="secondary" onClick={onRetry}>
        {ACCOUNT.tryAgain}
      </Button>
    </Card>
  )
}

/** "Wednesday, Oct 22" (adds the year when it isn't this year). */
function postedDate(ms) {
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

function Post({ post }) {
  // Older pages of this API sent only linkedinUrl.
  const links = post.links || (post.linkedinUrl ? [{ platform: 'linkedin', url: post.linkedinUrl }] : [])
  return (
    <Card as="article">
      <p className="text-sm text-muted">{POSTS.posted(postedDate(post.postedAt))}</p>
      <p className="max-w-[40rem] whitespace-pre-line font-display leading-normal">{post.text}</p>
      <p className="flex flex-wrap gap-x-6 gap-y-1 font-bold">
        <span>{POSTS.reactions(post.reactions)}</span>
        <span>{POSTS.comments(post.comments)}</span>
      </p>
      {links.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0">
          {links.map((link) => (
            <li key={link.platform}>
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-touch-sm items-center">
                {POSTS.view(POSTS.platforms[link.platform] || link.platform)}
                <span className="sr-only"> {POSTS.newTab}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export default function PostsTab({ elderId, token }) {
  const [state, setState] = useState({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    accountApi.listPosts(elderId, token).then(
      (posts) => live && setState({ status: 'ready', posts: posts || [] }),
      (error) => {
        console.error('listPosts failed', error.code || 'error')
        if (live) setState({ status: 'error', error })
      },
    )
    return () => {
      live = false
    }
  }, [elderId, token, attempt])

  return (
    <>
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-heading">{POSTS.title}</h1>
        <p className="max-w-[40rem]">{POSTS.lead}</p>
      </div>
      {state.status === 'loading' && <Loading label={POSTS.loading} />}
      {state.status === 'error' && <LoadError error={state.error} onRetry={() => setAttempt((a) => a + 1)} />}
      {state.status === 'ready' && state.posts.length === 0 && (
        <Card>
          <p>{POSTS.empty}</p>
        </Card>
      )}
      {state.status === 'ready' && state.posts.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-6 p-0">
          {state.posts.map((post) => (
            <li key={post.id}>
              <Post post={post} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
