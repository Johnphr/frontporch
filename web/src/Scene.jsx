// "Entrar a la casa": a Mexican house front whose door opens as the person moves through the 3 steps.
// step 1 closed door, 2 lights on and door ajar, 3 door open and garden visible, 4 fully open (done).
// Decorative only (aria-hidden). Flat colours, no gradients, so it can be rendered twice (desktop + mobile).

const FLAG_COLORS = ['#E4559A', '#F4B23E', '#4C7BC0', '#F08BB9', '#F9CD74', '#6C96D1']
const INK = '#1F4E8C'

export function SvgDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
      <defs>
        <symbol id="mg" viewBox="0 0 100 100">
          {Array.from({ length: 14 }, (_, i) => (
            <ellipse key={`a${i}`} cx="50" cy="19" rx="11" ry="19" fill="#F6B73C" stroke="#DE8A12" strokeWidth="0.8" strokeOpacity="0.6" transform={`rotate(${(i * 360) / 14} 50 50)`} />
          ))}
          {Array.from({ length: 10 }, (_, i) => (
            <ellipse key={`b${i}`} cx="50" cy="31" rx="9" ry="15" fill="#F29A1F" transform={`rotate(${(i * 360) / 10 + 18} 50 50)`} />
          ))}
          {Array.from({ length: 8 }, (_, i) => (
            <ellipse key={`c${i}`} cx="50" cy="39" rx="7" ry="11" fill="#E27A12" transform={`rotate(${(i * 360) / 8} 50 50)`} />
          ))}
          <circle cx="50" cy="50" r="8" fill="#B85C0B" />
        </symbol>
        <pattern id="dado" width="40" height="40" patternUnits="userSpaceOnUse">
          <rect width="40" height="40" fill="#F7F1E6" />
          <g transform="scale(0.8333)" fill="none" stroke={INK} strokeWidth="2.2" strokeOpacity="0.9">
            <path d="M24 4C30 12 30 12 38 10C36 18 36 18 44 24C36 30 36 30 38 38C30 36 30 36 24 44C18 36 18 36 10 38C12 30 12 30 4 24C12 18 12 18 10 10C18 12 18 12 24 4Z" />
            <circle cx="24" cy="24" r="5" />
          </g>
        </pattern>
        <clipPath id="arch">
          <path d="M160 520 V380 A40 40 0 0 1 240 380 V520Z" />
        </clipPath>
      </defs>
    </svg>
  )
}

const Flower = ({ x, y, s, style }) => <use href="#mg" x={x - s / 2} y={y - s / 2} width={s} height={s} style={style} />

function Window({ x, lit }) {
  const glass = { fill: lit ? '#FFD983' : '#9DB4DA', transition: 'fill 700ms ease' }
  return (
    <g>
      <rect x={x - 6} y={286} width={72} height={92} fill={INK} />
      <rect x={x} y={292} width={60} height={80} style={glass} />
      <line x1={x + 30} y1={292} x2={x + 30} y2={372} stroke={INK} strokeWidth="4" />
      <line x1={x} y1={332} x2={x + 60} y2={332} stroke={INK} strokeWidth="4" />
      <rect x={x - 8} y={378} width={76} height={20} fill="#B5532B" />
      <Flower x={x + 14} y={376} s={28} />
      <Flower x={x + 34} y={372} s={32} />
      <Flower x={x + 54} y={376} s={26} />
    </g>
  )
}

function Flags() {
  return (
    <g>
      <path d="M0 150 Q200 220 400 150" fill="none" stroke="#8A6A4C" strokeWidth="2" opacity="0.6" />
      {Array.from({ length: 10 }, (_, i) => {
        const t = (i + 0.5) / 10
        const x = 400 * t
        const y = 150 + 70 * t * (1 - t) * 1
        return (
          <polygon
            key={i}
            points={`${x - 16},${y} ${x + 16},${y} ${x + 16},${y + 30} ${x + 8},${y + 23} ${x},${y + 30} ${x - 8},${y + 23} ${x - 16},${y + 30}`}
            fill={FLAG_COLORS[i % FLAG_COLORS.length]}
            opacity="0.9"
          />
        )
      })}
    </g>
  )
}

const DOOR_OPEN = { 1: 1, 2: 0.55, 3: 0.18, 4: 0.12 }

export function Scene({ step = 1, compact = false }) {
  const lit = step >= 2
  const garden = step >= 3
  const scale = DOOR_OPEN[step] ?? 1
  const viewBox = compact ? '0 190 400 340' : '0 0 400 560'

  return (
    <div
      aria-hidden="true"
      className={compact ? 'h-[250px] w-full overflow-hidden bg-[#F9D9B8] md:hidden' : 'hidden h-full w-full overflow-hidden bg-[#F9D9B8] md:block'}
    >
      <svg viewBox={viewBox} preserveAspectRatio={compact ? 'xMidYMax slice' : 'xMidYMax meet'} className="block h-full w-full">
        <rect x="0" y="-200" width="400" height="760" fill="#F9D9B8" />
        <rect x="0" y="-200" width="400" height="360" fill="#F6C6A5" opacity="0.18" />
        <rect x="0" y="-200" width="400" height="300" fill="#F6C6A5" opacity="0.18" />
        <rect x="0" y="-200" width="400" height="240" fill="#F6C6A5" opacity="0.18" />
        <rect x="0" y="-200" width="400" height="180" fill="#F6C6A5" opacity="0.18" />
        <circle cx="320" cy="96" r="50" fill="#FBE2A8" opacity="0.7" />
        <circle cx="320" cy="96" r="32" fill="#F9C766" />
        <ellipse cx="80" cy="96" rx="44" ry="12" fill="#fff" opacity="0.55" />
        <ellipse cx="108" cy="86" rx="28" ry="10" fill="#fff" opacity="0.55" />
        <ellipse cx="230" cy="64" rx="38" ry="10" fill="#fff" opacity="0.45" />

        <Flags />

        {/* roof */}
        <rect x="18" y="198" width="364" height="10" fill="#8F3F1F" />
        <rect x="24" y="206" width="352" height="30" fill="#B5532B" />
        {Array.from({ length: 18 }, (_, i) => (
          <circle key={i} cx={34 + i * 19.5} cy="236" r="10" fill="#B5532B" />
        ))}

        {/* wall */}
        <rect x="30" y="236" width="340" height="284" fill="#E0408C" />
        <rect x="30" y="236" width="340" height="8" fill="#C22F76" />
        <rect x="30" y="456" width="340" height="4" fill={INK} />
        <rect x="30" y="460" width="340" height="60" fill="url(#dado)" />

        <Window x={56} lit={lit} />
        <Window x={284} lit={lit} />

        {/* door frame and interior */}
        <path d="M150 520 V380 A50 50 0 0 1 250 380 V520Z" fill={INK} />
        <path d="M160 520 V380 A40 40 0 0 1 240 380 V520Z" fill="#5A3A22" />
        <g clipPath="url(#arch)">
          <rect x="160" y="330" width="80" height="190" fill="#FFE3A3" style={{ opacity: lit ? 1 : 0, transition: 'opacity 700ms ease' }} />
          <g style={{ opacity: garden ? 1 : 0, transition: 'opacity 900ms ease 200ms' }}>
            <rect x="160" y="478" width="80" height="42" fill="#8FB07E" />
            <Flower x={176} y={478} s={26} />
            <Flower x={200} y={470} s={30} />
            <Flower x={224} y={478} s={26} />
            <Flower x={188} y={496} s={22} />
            <Flower x={214} y={498} s={22} />
          </g>
          <g style={{ transformOrigin: '160px 0px', transform: `scaleX(${scale})`, transition: 'transform 800ms cubic-bezier(.3,.7,.3,1)' }}>
            <rect x="160" y="330" width="80" height="190" fill="#8A4A22" />
            <line x1="180" y1="330" x2="180" y2="520" stroke="#6E3A1A" strokeWidth="2" />
            <line x1="200" y1="330" x2="200" y2="520" stroke="#6E3A1A" strokeWidth="2" />
            <line x1="220" y1="330" x2="220" y2="520" stroke="#6E3A1A" strokeWidth="2" />
            <rect x="170" y="392" width="60" height="44" fill="none" stroke="#6E3A1A" strokeWidth="3" />
            <rect x="170" y="446" width="60" height="56" fill="none" stroke="#6E3A1A" strokeWidth="3" />
            <circle cx="229" cy="452" r="5" fill="#F6B73C" />
          </g>
        </g>

        {/* lantern */}
        <line x1="200" y1="236" x2="200" y2="296" stroke="#5A4C42" strokeWidth="2" />
        <circle cx="200" cy="312" r="22" fill="#FFD983" style={{ opacity: lit ? 0.5 : 0, transition: 'opacity 700ms ease' }} />
        <rect x="193" y="298" width="14" height="22" rx="4" style={{ fill: lit ? '#FFD983' : '#C8A66B', transition: 'fill 700ms ease' }} stroke="#5A4C42" strokeWidth="2" />

        {/* marigold garland around the door */}
        <g style={{ opacity: step >= 3 ? 1 : 0, transition: 'opacity 900ms ease 300ms' }}>
          {Array.from({ length: 9 }, (_, i) => {
            const a = Math.PI - (i * Math.PI) / 8
            return <Flower key={i} x={200 + 58 * Math.cos(a)} y={380 - 58 * Math.sin(a)} s={18} />
          })}
        </g>

        {/* pots beside the door */}
        {[[134, 1], [266, -1]].map(([x, d]) => (
          <g key={x}>
            <path d={`M${x - 10} 492 H${x + 10} L${x + 7} 520 H${x - 7}Z`} fill="#B5532B" />
            <Flower x={x} y={480} s={30} />
            <Flower x={x + 16 * d} y={470} s={24} />
            <Flower x={x - 8 * d} y={460} s={24} />
          </g>
        ))}

        {/* street */}
        <rect x="0" y="520" width="400" height="60" fill="#BF9568" />
        <ellipse cx="200" cy="522" rx="80" ry="12" fill="#FFD983" style={{ opacity: lit ? 0.7 : 0, transition: 'opacity 700ms ease' }} />
        {[[40, 540], [120, 548], [260, 542], [340, 550], [200, 556]].map(([x, y]) => (
          <ellipse key={x} cx={x} cy={y} rx="18" ry="5" fill="#AD8456" />
        ))}
      </svg>
    </div>
  )
}

/** Large flower used on the final screen. */
export function BigMarigold({ className }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className={className}>
      <use href="#mg" width="100" height="100" />
    </svg>
  )
}
