// Victoria in 3D (attentive, courteous, precise; mid-30s): neat auburn bun with a side-swept front,
// round glasses, plum blazer over a white shirt, pearl earrings. Colours from VictoriaAvatar in
// src/art/hosts.jsx.
import { Bust } from './Bust'
import { U, normalAt, onSurface, sx, sy } from './geom'
import { Blob, Decal, Dot, Eye, HEAD_SLIM, HairShell, Head, Neck, Ring, Rod, Stroke, TORSO, Torso, scalp } from './parts'

const HAIR = '#8E4A33'
const FRAME = '#5A4549'
const ON = HEAD_SLIM
const SCALP = scalp(ON, 0.035)

/** Round frames over each eye, a bridge, and arms back to the ears. */
function Glasses() {
  return (
    <group>
      {[86, 114].map((x) => {
        const n = normalAt(ON.z, sx(x), sy(96))
        const tilt = [-n.y * 0.6, n.x * 0.6, 0]
        return (
          <Ring
            key={x}
            R={10 * U}
            t={1.4 * U}
            color={FRAME}
            rough={0.45}
            position={onSurface(ON.z, sx(x), sy(96), 0.09)}
            rotation={tilt}
          />
        )
      })}
      <Stroke d="M96 95 Q100 92 104 95" on={ON} lift={0.1} width={2.6} color={FRAME} />
      {[-1, 1].map((s) => {
        const front = onSurface(ON.z, s * sx(124), sy(96), 0.08)
        return <Rod key={s} from={[front.x, front.y, front.z]} to={[s * 0.88, sy(98), -0.12]} radius={1.2 * U} color={FRAME} />
      })}
    </group>
  )
}

export default function Victoria() {
  return (
    <Bust
      body={
        <>
          <Torso color="#5A4549" />
          <Decal on={TORSO} d="M84 144 L100 174 L116 144 Z" color="#FFFFFF" lift={0.01} />
          <Decal on={TORSO} d="M78 146 L96 184 L86 200 L64 200 Z M122 146 L104 184 L114 200 L136 200 Z" color="#4A373B" lift={0.022} />
          <Neck color="#DDAE8E" />
        </>
      }
      head={
        <>
          <Blob color={HAIR} position={[0, sy(42), -0.32]} scale={[0.42, 0.4, 0.4]} />
          <Head skin="#EBC2A2" on={ON} />
          <HairShell color={HAIR} on={ON} gap={0.04} cap={0} back={1.62} wrap={0.25} />
          <Decal
            on={SCALP}
            d="M63 96 Q58 52 100 50 Q142 52 137 96 Q132 72 116 64 Q96 72 72 68 Q65 78 63 96 Z"
            color={HAIR}
            lift={0.005}
          />
          {[-1, 1].map((s) => (
            <Blob key={s} color="#FFFFFF" position={[s * 0.9, sy(110), -0.02]} scale={3.6 * U} rough={0.25} />
          ))}
          <Eye x={86} y={96} r={3.6} on={ON} />
          <Eye x={114} y={96} r={3.6} on={ON} />
          <Glasses />
          <Dot x={76} y={112} r={5} color="#F2A6B6" on={ON} />
          <Dot x={124} y={112} r={5} color="#F2A6B6" on={ON} />
          <Stroke d="M92 118 Q100 123 108 118" on={ON} width={3} />
        </>
      }
    />
  )
}
