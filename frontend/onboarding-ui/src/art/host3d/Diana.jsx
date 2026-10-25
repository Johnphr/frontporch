// Diana in 3D (enthusiastic, grateful, humble; 25): long dark hair, smiling eyes, a big open
// smile, berry top, gold hoop earrings. Colours from DianaAvatar in src/art/hosts.jsx.
import { Bust } from './Bust'
import { U, cached, mat, slabGeometry, sy } from './geom'
import { Decal, Dot, HEAD_SLIM, HairShell, Head, INK, Neck, Ring, Stroke, TORSO, Torso, scalp } from './parts'

const HAIR = INK
const SKIN = '#B87A54'
const ON = HEAD_SLIM
const SCALP = scalp(ON, 0.04)

// The SVG's long hair outline, pushed back into a soft slab behind the head and shoulders.
const LONG = 'M56 96 Q48 42 100 40 Q152 42 144 96 Q150 130 156 166 Q100 180 44 166 Q50 130 56 96 Z'

function LongHair() {
  const geo = cached('diana-long', () => slabGeometry(LONG, 0.55, 0.16))
  return <mesh geometry={geo} material={mat(HAIR)} position={[0, 0, -0.95]} />
}

export default function Diana() {
  return (
    <Bust
      body={
        <>
          <Torso color="#A8455E" />
          <Decal on={TORSO} d="M76 147 Q100 168 124 147 Z" color={SKIN} lift={0.01} />
          <Neck color="#AD7049" />
        </>
      }
      head={
        <>
          <LongHair />
          <Head skin={SKIN} on={ON} />
          <HairShell color={HAIR} on={ON} gap={0.07} cap={0.75} back={1.6} wrap={0.3} lift={0.06} />
          <Decal on={SCALP} d="M63 94 Q60 52 104 48 Q86 62 78 96 Z" color={HAIR} lift={0.005} />
          <Decal on={SCALP} d="M100 48 Q140 50 138 94 Q128 64 100 57 Z" color={HAIR} lift={0.005} />
          {[-1, 1].map((s) => (
            <Ring
              key={s}
              R={5 * U}
              t={1.3 * U}
              color="#D9A441"
              rough={0.35}
              metal={0.5}
              position={[s * 0.9, sy(112), 0.02]}
              rotation={[0, s * 0.5, 0]}
            />
          ))}
          <Stroke d="M81 97 q5 -6 10 0" on={ON} width={3.6} />
          <Stroke d="M109 97 q5 -6 10 0" on={ON} width={3.6} />
          <Dot x={75} y={109} r={6} color="#E58FA3" on={ON} />
          <Dot x={125} y={109} r={6} color="#E58FA3" on={ON} />
          {/* Mouth a touch deeper than the SVG's: the face curves away from the camera there. */}
          <Decal on={ON} d="M87 113 Q100 134 113 113 Z" color="#7A2E40" lift={0.012} />
          <Decal on={ON} d="M89 114 Q100 118 111 114 L110 117 Q100 121 90 117 Z" color="#FFFFFF" lift={0.02} />
        </>
      }
    />
  )
}
