// Daniel in 3D (kind, easygoing, a little innocent): soft light-brown curls, rosy cheeks, sage
// sweater with a crew collar. Colours and positions from DanielAvatar in src/art/hosts.jsx.
import { Bust } from './Bust'
import { U, sx, sy } from './geom'
import { Blob, Dot, Eye, HEAD, HairShell, Head, Neck, Ring, Stroke, Torso } from './parts'

const HAIR = '#9C6A3F'

// The SVG's curls (x, y, r), pushed onto the front of the skull.
const FRONT = [
  [68, 68, 14],
  [83, 56, 16],
  [101, 52, 16],
  [119, 56, 15],
  [133, 68, 13],
  [64, 82, 9],
  [137, 82, 9],
  [93, 65, 11],
  [111, 65, 11],
]
// More curls round the crown and the back so it stays curly when the head turns.
const BACK = []
for (const [theta, step] of [
  [0.35, 0.9],
  [0.8, 0.62],
  [1.2, 0.5],
  [1.55, 0.5],
]) {
  for (let phi = Math.PI; phi > -Math.PI + 0.01; phi -= step) {
    if (Math.cos(phi) > -0.1 && theta > 0.4) continue // the front belongs to the SVG curls
    BACK.push([Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi)])
  }
}

function Curls() {
  const [a, b, c] = HEAD.r
  return (
    <group>
      {FRONT.map(([x, y, r]) => {
        const z = HEAD.z(sx(x), sy(y))
        return <Blob key={`${x}${y}`} color={HAIR} position={[sx(x), sy(y), Math.max(0.05, z * 0.72)]} scale={r * U} />
      })}
      {BACK.map(([x, y, z], i) => (
        <Blob key={i} color={HAIR} position={[x * a, sy(94) + y * b * 1.02, z * c]} scale={0.34} />
      ))}
    </group>
  )
}

export default function Daniel() {
  return (
    <Bust
      body={
        <>
          <Torso color="#7E9E8B" />
          <Neck color="#E2B08F" />
          <Ring R={0.34} t={0.13} color="#6E8C7A" position={[0, -1.17, 0.06]} rotation={[Math.PI / 2 - 0.45, 0, 0]} scale={[1.1, 1, 1]} />
        </>
      }
      head={
        <>
          <Head skin="#EDC2A2" />
          <HairShell color={HAIR} cap={0.5} back={1.7} />
          <Curls />
          <Eye x={86} y={96} />
          <Eye x={114} y={96} />
          <Dot x={76} y={110} r={5.5} color="#F2A6B6" />
          <Dot x={124} y={110} r={5.5} color="#F2A6B6" />
          <Stroke d="M90 115 Q100 125 110 115" width={3.2} />
        </>
      }
    />
  )
}
