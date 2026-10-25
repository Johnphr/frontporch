// Oscar in 3D (funny, down-to-earth, nostalgic): berry beanie with a darker band and pompom,
// stubble, pink headphones round the neck, and a wink. Colours from OscarAvatar in src/art/hosts.jsx.
import * as THREE from 'three'
import { Bust } from './Bust'
import { cached, mat, mix, onSurface, sy } from './geom'
import { Blob, Decal, Dot, Eye, Head, INK, Neck, Ring, Stroke, TORSO, Torso } from './parts'

const SKIN = '#8A5A3B'
const BERRY = '#A8455E'
const PINK = '#F2B8C6'

/** Slouchy beanie: a dome over the crown, a rolled band, a pompom on top. */
function Beanie() {
  const dome = cached('beanie', () => new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2))
  return (
    <group>
      <mesh geometry={dome} material={mat(BERRY)} position={[0, sy(80), -0.02]} scale={[0.99, 1.16, 0.96]} />
      <Ring R={0.9} t={0.175} color="#86344A" position={[0, sy(79.5), -0.02]} rotation={[Math.PI / 2, 0, 0]} scale={[1.02, 0.98, 1]} />
      <Blob color={BERRY} position={[0, sy(31), -0.05]} scale={0.24} />
    </group>
  )
}

/** Headphones resting round the neck: two pink cups joined by a band that dips under the chin. */
function Headphones() {
  const band = cached('oscar-band', () => {
    const pts = [
      [-0.8, -1.12, 0.12],
      [-0.78, -1.5, 0.45],
      [-0.45, -1.78, 0.78],
      [0, -1.86, 0.92],
      [0.45, -1.78, 0.78],
      [0.78, -1.5, 0.45],
      [0.8, -1.12, 0.12],
    ].map(([x, y, z]) => {
      const lifted = onSurface(TORSO.z, x, y, 0.07)
      return new THREE.Vector3(x, y, Math.max(z, lifted.z))
    })
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.075, 10, false)
  })
  const cup = cached('oscar-cup', () => new THREE.CapsuleGeometry(0.2, 0.22, 6, 16))
  return (
    <group>
      <mesh geometry={band} material={mat(INK, { rough: 0.5 })} />
      {[-1, 1].map((s) => (
        <mesh
          key={s}
          geometry={cup}
          material={mat(PINK)}
          position={[s * 0.84, -0.98, 0.16]}
          rotation={[0.15, s * 0.35, s * 0.25]}
          scale={[1, 1, 0.75]}
        />
      ))}
    </group>
  )
}

export default function Oscar() {
  return (
    <Bust
      body={
        <>
          <Torso color="#6E9580" />
          <Decal on={TORSO} d="M80 146 L100 166 L120 146 Z" color="#5E8470" lift={0.01} />
          <Neck color="#7A5036" />
          <Headphones />
        </>
      }
      head={
        <>
          <Head skin={SKIN} />
          <Decal
            d="M65 108 Q67 136 100 138 Q133 136 135 108 Q131 127 100 129 Q69 127 65 108 Z"
            color={mix(INK, SKIN, 0.45)}
            lift={0.006}
            rough={1}
          />
          <Beanie />
          <Stroke d="M81 100 q5 3 10 0" width={3.4} />
          <Eye x={114} y={99} />
          <Dot x={76} y={112} r={5} color={mix('#C9707F', SKIN, 0.7)} />
          <Dot x={124} y={112} r={5} color={mix('#C9707F', SKIN, 0.7)} />
          <Stroke d="M88 118 Q102 127 114 116" width={3.4} />
        </>
      }
    />
  )
}
