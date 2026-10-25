// Shared pieces for the landing scenes: a decorative <svg> wrapper, a seat that places a 200x200
// portrait anywhere in a bigger picture, sound waves, a heart, a check badge, a call badge and a
// phone held to the ear (drawn in portrait units, on the viewer's right).

// Sound waves pulse gently (the second one a beat later); off with reduced motion.
const WAVE = 'motion-safe:animate-ring'
const WAVE_LATE = 'motion-safe:animate-ring motion-safe:[animation-delay:0.4s]'
const waveStroke = { fill: 'none', stroke: '#A8475E', strokeLinecap: 'round' }

/** Decorative SVG that scales to its container's width. */
export function Deco({ viewBox, className = 'block h-auto w-full', children }) {
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

/** Places a portrait (pass it className="") at x, y with a size; `halo` adds a white ring. */
export function Seat({ x, y, size, halo = 0, children }) {
  return (
    <>
      {halo > 0 && <circle cx={x + size / 2} cy={y + size / 2} r={size / 2 + halo} fill="#FFFFFF" />}
      <svg x={x} y={y} width={size} height={size} viewBox="0 0 200 200">
        {children}
      </svg>
    </>
  )
}

/** Two arcs fanning out from (x, y); `dir` -1 points them left. */
export function Waves({ x, y, r = 14, dir = 1, width = 4 }) {
  const a = (k) => x + dir * r * k
  return (
    <>
      <path className={WAVE} d={`M${a(0)} ${y - r} Q${a(0.7)} ${y} ${a(0)} ${y + r}`} {...waveStroke} strokeWidth={width} />
      <path
        className={WAVE_LATE}
        d={`M${a(0.85)} ${y - r * 1.75} Q${a(2)} ${y} ${a(0.85)} ${y + r * 1.75}`}
        {...waveStroke}
        strokeWidth={width}
      />
    </>
  )
}

/** A heart centred on (x, y), about 2r wide. */
export function Heart({ x, y, r, fill = '#A8475E' }) {
  return (
    <path
      d={`M${x} ${y + r * 0.85} C${x - r * 1.5} ${y - r * 0.1} ${x - r * 0.75} ${y - r * 1.25} ${x} ${y - r * 0.4} C${x + r * 0.75} ${y - r * 1.25} ${x + r * 1.5} ${y - r * 0.1} ${x} ${y + r * 0.85} Z`}
      fill={fill}
    />
  )
}

/** Round badge with a white tick and a white ring, centred on (x, y). */
export function CheckBadge({ x, y, r, fill = '#6E9580' }) {
  return (
    <>
      <circle cx={x} cy={y} r={r + r * 0.22} fill="#FFFFFF" />
      <circle cx={x} cy={y} r={r} fill={fill} />
      <path
        d={`M${x - r * 0.42} ${y + r * 0.02} L${x - r * 0.12} ${y + r * 0.32} L${x + r * 0.45} ${y - r * 0.3}`}
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={r * 0.22}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  )
}

/** Rose circle with a white phone handset, centred on (x, y). */
export function CallBadge({ x, y, r }) {
  const s = (r * 1.1) / 24
  return (
    <>
      <circle cx={x} cy={y} r={r} fill="#A8475E" />
      <path
        transform={`translate(${x - 12 * s} ${y - 12 * s}) scale(${s})`}
        d="M5 3 h4 l1.6 4.6 -2.6 1.9 a11 11 0 0 0 5.5 5.5 l1.9 -2.6 4.6 1.6 v4 a2 2 0 0 1 -2 2 A16 16 0 0 1 3 5 a2 2 0 0 1 2 -2 z"
        fill="#FFFFFF"
      />
    </>
  )
}

/** A hand holding a phone to the ear, in portrait units (viewer's right). `flip` mirrors it. */
export function PhoneInHand({ skin, shade, sleeve, flip = false }) {
  return (
    <g transform={flip ? 'matrix(-1 0 0 1 200 0)' : undefined}>
      <path d="M140 200 Q142 160 150 132 L174 136 Q176 170 190 200 Z" fill={sleeve} />
      <rect x="136" y="64" width="18" height="58" rx="6" fill="#3A2A2E" transform="rotate(12 145 93)" />
      <rect x="140" y="94" width="28" height="40" rx="13" fill={skin} transform="rotate(12 154 114)" />
      <rect x="130" y="96" width="24" height="27" rx="9" fill={skin} />
      <path d="M132 105 h8 M132 114 h8" fill="none" stroke={shade} strokeWidth="2" strokeLinecap="round" />
    </g>
  )
}
