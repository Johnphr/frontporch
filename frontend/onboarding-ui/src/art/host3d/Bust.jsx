// Idle motion shared by every host: slow breathing bob, a slight head sway, and the head turning a
// little towards the pointer. Only runs while the canvas animates (frameloop "always"); with
// reduced motion the scene renders on demand and the bust stays in its rest pose.
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'

const NECK = -0.85 // head pivot: the top of the neck

/** Window pointer position relative to the canvas centre, roughly -1..1 (y up). */
function usePointer() {
  const gl = useThree((s) => s.gl)
  const p = useRef({ x: 0, y: 0 })
  useEffect(() => {
    const move = (e) => {
      const r = gl.domElement.getBoundingClientRect()
      const clamp = (v) => Math.max(-1, Math.min(1, v))
      p.current.x = clamp((e.clientX - (r.left + r.width / 2)) / (r.width * 1.5))
      p.current.y = clamp(-(e.clientY - (r.top + r.height / 2)) / (r.height * 1.5))
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => window.removeEventListener('pointermove', move)
  }, [gl])
  return p
}

export function Bust({ body, head }) {
  const root = useRef()
  const headRef = useRef()
  const pointer = usePointer()

  useFrame((state, dt) => {
    if (state.frameloop !== 'always') return
    const t = state.clock.elapsedTime
    const breath = Math.sin(t * 1.25)
    root.current.position.y = breath * 0.03
    root.current.scale.set(1 + breath * 0.004, 1, 1 + breath * 0.006)

    const h = headRef.current
    const k = 1 - Math.exp(-dt * 3)
    h.rotation.y += (Math.sin(t * 0.45) * 0.07 + pointer.current.x * 0.3 - h.rotation.y) * k
    h.rotation.x += (Math.sin(t * 0.33) * 0.025 - pointer.current.y * 0.14 - h.rotation.x) * k
    h.rotation.z += (Math.sin(t * 0.6 + 1) * 0.035 - h.rotation.z) * k
  })

  return (
    <group ref={root}>
      {body}
      <group ref={headRef} position={[0, NECK, 0]}>
        <group position={[0, -NECK, 0]}>{head}</group>
      </group>
    </group>
  )
}
