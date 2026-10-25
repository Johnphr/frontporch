// Host shown as a gently idling 3D bust (the big picture in setup's host step). three.js loads
// lazily, so other pages don't pay for it; until it arrives, and whenever WebGL is missing or the
// canvas fails, the flat SVG portrait stands in at the same size. Decorative: the host's name is
// always next to it. Usage: <HostStage id="daniel" className="h-80 w-80" />
import { Component, Suspense, lazy, useEffect, useRef, useState } from 'react'
import { HostAvatar } from '../hosts'

const Scene = lazy(() => import('./Scene'))

let webgl
function hasWebGL() {
  if (webgl === undefined) {
    try {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl')
      webgl = !!gl
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      webgl = false
    }
  }
  return webgl
}

const REDUCE = '(prefers-reduced-motion: reduce)'

function useReducedMotion() {
  const [reduce, setReduce] = useState(() => window.matchMedia?.(REDUCE).matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(REDUCE)
    if (!mq) return undefined
    const change = () => setReduce(mq.matches)
    mq.addEventListener('change', change)
    return () => mq.removeEventListener('change', change)
  }, [])
  return reduce
}

/** Falls back to the flat portrait if the 3D canvas throws. */
class Fallback extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.warn('HostStage: 3D host failed, showing the flat portrait.', error)
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function HostStage({ id, className = 'h-80 w-80' }) {
  const still = useReducedMotion()
  const box = useRef(null)
  const first = useRef(true)
  const flat = <HostAvatar id={id} className="h-full w-full" />

  // Quick swap when the host changes (skipped with reduced motion).
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!still) {
      box.current?.animate?.([{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }], {
        duration: 260,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      })
    }
  }, [id, still])

  return (
    <div ref={box} className={`relative ${className}`} aria-hidden="true">
      {hasWebGL() ? (
        <Fallback fallback={flat}>
          <Suspense fallback={flat}>
            <Scene id={id} still={still} />
          </Suspense>
        </Fallback>
      ) : (
        flat
      )}
    </div>
  )
}

export default HostStage
