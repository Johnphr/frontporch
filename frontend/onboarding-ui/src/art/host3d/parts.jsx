// Shared body parts for the 3D hosts: rounded torso, neck, head with ears, hair shells, eyes that
// blink, cheeks, and SVG paths laid onto the head or torso as decals and strokes. Positions use the
// flat portraits' SVG coordinates (see geom.js) so every bust matches its drawing.
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  U,
  cached,
  decalGeometry,
  ellipsoid,
  facing,
  latheSurface,
  mat,
  normalAt,
  onSurface,
  strokeGeometry,
  sx,
  sy,
} from './geom'

export const INK = '#3A2A2E'

// Head: the SVG face ellipse (centre 100,94; rx 37, ry 43, or 36/42 for the slimmer women's faces).
const HEAD_C = [0, sy(94), 0]
export const HEAD = { id: 'head', r: [37 * U, 43 * U, 0.9], z: ellipsoid(HEAD_C, [37 * U, 43 * U, 0.9]) }
export const HEAD_SLIM = { id: 'slim', r: [36 * U, 42 * U, 0.88], z: ellipsoid(HEAD_C, [36 * U, 42 * U, 0.88]) }

/** A surface just above the head (for hair laid on the scalp). */
export function scalp(head, gap) {
  const r = head.r.map((v) => v + gap)
  return { id: `${head.id}+${gap}`, r, z: ellipsoid(HEAD_C, r) }
}

// Torso: a soft rounded bust (shoulders like the SVG's, a flat rounded base), squashed in depth.
const PROFILE = new THREE.SplineCurve(
  [
    [0.001, -2.55],
    [1.45, -2.55],
    [1.72, -2.43],
    [1.82, -2.14],
    [1.76, -1.8],
    [1.5, -1.44],
    [1.02, -1.22],
    [0.45, -1.13],
    [0.001, -1.11],
  ].map(([r, y]) => new THREE.Vector2(r, y)),
).getPoints(48)
const TORSO_DEPTH = 0.62
export const TORSO = { id: 'torso', z: latheSurface(PROFILE, TORSO_DEPTH) }

const SPHERE = new THREE.SphereGeometry(1, 40, 28)

/** Sphere stretched into an ellipsoid. `scale` is a number or [x, y, z]. */
export function Blob({ color, position, scale = 1, rotation, rough, metal }) {
  return <mesh geometry={SPHERE} material={mat(color, { rough, metal })} position={position} scale={scale} rotation={rotation} />
}

export function Torso({ color }) {
  const geo = cached('torso', () => new THREE.LatheGeometry(PROFILE, 48))
  return <mesh geometry={geo} material={mat(color)} scale={[1, 1, TORSO_DEPTH]} />
}

export function Neck({ color }) {
  const geo = cached('neck', () => new THREE.CylinderGeometry(11 * U, 12 * U, 1.1, 24))
  return <mesh geometry={geo} material={mat(color)} position={[0, -1.0, -0.05]} />
}

/** Face ellipsoid plus small ears. */
export function Head({ skin, on = HEAD }) {
  const [a, b, c] = on.r
  return (
    <group>
      <Blob color={skin} position={HEAD_C} scale={[a, b, c]} />
      {[-1, 1].map((s) => (
        <Blob key={s} color={skin} position={[s * (a - 0.03), sy(100), -0.08]} scale={[0.1, 0.17, 0.12]} />
      ))}
    </group>
  )
}

/**
 * Hair covering the skull: a cap over the top (down to polar angle `cap`) and a back half that
 * wraps a little forward round the sides (down to `back`). Radii are the head's plus `gap`.
 */
export function HairShell({ color, on = HEAD, gap = 0.05, cap = 0.6, back = 1.75, wrap = 0.35, lift = 0 }) {
  const [a, b, c] = on.r.map((v) => v + gap)
  const geos = cached(`shell|${cap}|${back}|${wrap}`, () => [
    cap > 0 && new THREE.SphereGeometry(1, 40, 16, 0, Math.PI * 2, 0, cap),
    new THREE.SphereGeometry(1, 40, 24, Math.PI - wrap, Math.PI + 2 * wrap, 0, back),
  ])
  return (
    <group position={[0, HEAD_C[1] + lift, 0]} scale={[a, b, c]}>
      {geos.filter(Boolean).map((g, i) => (
        <mesh key={i} geometry={g} material={mat(color)} />
      ))}
    </group>
  )
}

/** A filled SVG path on a surface. */
export function Decal({ d, on = HEAD, lift = 0.012, color, rough }) {
  const geo = cached(`decal|${on.id}|${lift}|${d}`, () => decalGeometry(d, on.z, lift))
  return <mesh geometry={geo} material={mat(color, { rough })} />
}

/** A stroked SVG path (round caps) on a surface; `width` in SVG px like strokeWidth. */
export function Stroke({ d, on = HEAD, lift = 0.02, width, color = INK }) {
  const r = (width / 2) * U
  const { geo, ends } = cached(`stroke|${on.id}|${lift}|${width}|${d}`, () => strokeGeometry(d, on.z, lift, r))
  return (
    <group>
      <mesh geometry={geo} material={mat(color, { rough: 0.5 })} />
      {ends.map((p, i) => (
        <Blob key={i} color={color} position={p} scale={r} rough={0.5} />
      ))}
    </group>
  )
}

/** Round SVG dot (cheek, earring stud...) flattened onto a surface. */
export function Dot({ x, y, r, color, on = HEAD, lift = 0, depth = 0.35, rough }) {
  const n = normalAt(on.z, sx(x), sy(y))
  return (
    <group position={onSurface(on.z, sx(x), sy(y), lift)} quaternion={facing(n)}>
      <Blob color={color} scale={[r * U, r * U, r * U * depth]} rough={rough} />
    </group>
  )
}

/** Open eye (SVG dot) that blinks now and then while the scene animates. */
export function Eye({ x, y, r = 4, on = HEAD }) {
  const ref = useRef()
  const next = useRef(1.5 + Math.random() * 2)
  useFrame((state) => {
    if (state.frameloop !== 'always' || !ref.current) return
    const t = state.clock.elapsedTime
    const closing = t > next.current && t < next.current + 0.14
    ref.current.scale.y = closing ? 0.12 : 1
    if (t > next.current + 0.14) next.current = t + 2.5 + Math.random() * 3.5
  })
  const n = useMemo(() => normalAt(on.z, sx(x), sy(y)), [on, x, y])
  return (
    <group position={onSurface(on.z, sx(x), sy(y), 0)} quaternion={facing(n)}>
      <group ref={ref}>
        <Blob color={INK} scale={[r * U * 1.05, r * U * 1.15, r * U * 0.6]} rough={0.35} />
      </group>
    </group>
  )
}

/** Thin rod between two points (glasses arms). */
export function Rod({ from, to, radius, color }) {
  const a = new THREE.Vector3(...from)
  const b = new THREE.Vector3(...to)
  const dir = b.clone().sub(a)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
  const geo = cached('rod', () => new THREE.CylinderGeometry(1, 1, 1, 10))
  return (
    <mesh
      geometry={geo}
      material={mat(color, { rough: 0.5 })}
      position={a.clone().add(b).multiplyScalar(0.5)}
      quaternion={q}
      scale={[radius, dir.length(), radius]}
    />
  )
}

/** Torus helper: ring of radius R and tube t (radial segments kept low for the clay look). */
export function Ring({ R, t, color, arc = Math.PI * 2, rough, metal, ...props }) {
  const geo = cached(`ring|${R}|${t}|${arc}`, () => new THREE.TorusGeometry(R, t, 14, 48, arc))
  return <mesh geometry={geo} material={mat(color, { rough, metal })} {...props} />
}
