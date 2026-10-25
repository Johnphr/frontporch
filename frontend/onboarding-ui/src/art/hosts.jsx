// Host portraits (design: "Front Porch callers" mockup). Flat, no outlines, head and shoulders in a
// soft circle. Each look follows the host's voice prompt and the qualities shown in the UI.
// Decorative: the host's name is always next to it.
//   Daniel (kind, easygoing, a little innocent): soft light-brown curls, rosy cheeks, sage sweater.
//   Oscar (funny, down-to-earth, nostalgic): berry beanie, stubble, pink headphones, a wink.
//   Victoria (attentive, courteous, precise; mid-30s): neat auburn bun, glasses, plum blazer, pearls.
//   Diana (enthusiastic, grateful, humble; 25): long dark hair, big open smile, berry top, gold hoops.
import { useId } from 'react'

export function Portrait({ bg, className = 'h-24 w-24', children }) {
  const clip = useId()
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true" focusable="false">
      <clipPath id={clip}>
        <circle cx="100" cy="100" r="100" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect width="200" height="200" fill={bg} />
        {children}
      </g>
    </svg>
  )
}

const ROUND = { fill: 'none', strokeLinecap: 'round' }

const DanielAvatar = ({ className }) => (
  <Portrait bg="#E5EEE9" className={className}>
    <path d="M30 200 Q34 150 100 146 Q166 150 170 200 Z" fill="#7E9E8B" />
    <path d="M80 148 Q100 162 120 148" {...ROUND} stroke="#6E8C7A" strokeWidth="7" />
    <rect x="89" y="122" width="22" height="30" rx="8" fill="#E2B08F" />
    <ellipse cx="100" cy="94" rx="37" ry="43" fill="#EDC2A2" />
    <g fill="#9C6A3F">
      <circle cx="68" cy="68" r="14" />
      <circle cx="83" cy="56" r="16" />
      <circle cx="101" cy="52" r="16" />
      <circle cx="119" cy="56" r="15" />
      <circle cx="133" cy="68" r="13" />
      <circle cx="64" cy="82" r="9" />
      <circle cx="137" cy="82" r="9" />
      <circle cx="93" cy="65" r="11" />
      <circle cx="111" cy="65" r="11" />
    </g>
    <circle cx="86" cy="96" r="4" fill="#3A2A2E" />
    <circle cx="114" cy="96" r="4" fill="#3A2A2E" />
    <circle cx="76" cy="110" r="5.5" fill="#F2A6B6" />
    <circle cx="124" cy="110" r="5.5" fill="#F2A6B6" />
    <path d="M90 115 Q100 125 110 115" {...ROUND} stroke="#3A2A2E" strokeWidth="3.2" />
  </Portrait>
)

const OscarAvatar = ({ className }) => (
  <Portrait bg="#E5EEE9" className={className}>
    <path d="M30 200 Q34 150 100 146 Q166 150 170 200 Z" fill="#6E9580" />
    <path d="M84 148 L100 164 L116 148" fill="#5E8470" />
    <rect x="89" y="120" width="22" height="32" rx="8" fill="#7A5036" />
    <path d="M68 140 Q68 168 100 170 Q132 168 132 140" {...ROUND} stroke="#3A2A2E" strokeWidth="6" />
    <rect x="58" y="128" width="19" height="25" rx="8" fill="#F2B8C6" />
    <rect x="123" y="128" width="19" height="25" rx="8" fill="#F2B8C6" />
    <ellipse cx="100" cy="94" rx="37" ry="43" fill="#8A5A3B" />
    <path d="M65 108 Q67 136 100 138 Q133 136 135 108 Q131 127 100 129 Q69 127 65 108 Z" fill="#3A2A2E" opacity="0.35" />
    <path d="M61 80 Q59 36 100 34 Q141 36 139 80 Z" fill="#A8455E" />
    <rect x="57" y="72" width="86" height="15" rx="7.5" fill="#86344A" />
    <circle cx="100" cy="32" r="8" fill="#A8455E" />
    <path d="M81 100 q5 3 10 0" {...ROUND} stroke="#3A2A2E" strokeWidth="3.4" />
    <circle cx="114" cy="99" r="4" fill="#3A2A2E" />
    <circle cx="76" cy="112" r="5" fill="#C9707F" opacity="0.7" />
    <circle cx="124" cy="112" r="5" fill="#C9707F" opacity="0.7" />
    <path d="M88 118 Q102 127 114 116" {...ROUND} stroke="#3A2A2E" strokeWidth="3.4" />
  </Portrait>
)

const VictoriaAvatar = ({ className }) => (
  <Portrait bg="#FCE4E8" className={className}>
    <path d="M30 200 Q34 150 100 146 Q166 150 170 200 Z" fill="#5A4549" />
    <path d="M85 146 L100 174 L115 146 Z" fill="#FFFFFF" />
    <path d="M78 146 L96 184 L86 200 L64 200 Z M122 146 L104 184 L114 200 L136 200 Z" fill="#4A373B" />
    <rect x="89" y="122" width="22" height="28" rx="8" fill="#DDAE8E" />
    <circle cx="100" cy="42" r="16" fill="#8E4A33" />
    <circle cx="63" cy="110" r="3.6" fill="#FFFFFF" />
    <circle cx="137" cy="110" r="3.6" fill="#FFFFFF" />
    <ellipse cx="100" cy="94" rx="36" ry="42" fill="#EBC2A2" />
    <path d="M63 96 Q58 52 100 50 Q142 52 137 96 Q132 72 116 64 Q96 72 72 68 Q65 78 63 96 Z" fill="#8E4A33" />
    <circle cx="86" cy="96" r="3.6" fill="#3A2A2E" />
    <circle cx="114" cy="96" r="3.6" fill="#3A2A2E" />
    <circle cx="86" cy="96" r="10" fill="none" stroke="#5A4549" strokeWidth="2.6" />
    <circle cx="114" cy="96" r="10" fill="none" stroke="#5A4549" strokeWidth="2.6" />
    <path d="M96 95 Q100 92 104 95" fill="none" stroke="#5A4549" strokeWidth="2.6" />
    <circle cx="76" cy="112" r="5" fill="#F2A6B6" />
    <circle cx="124" cy="112" r="5" fill="#F2A6B6" />
    <path d="M92 118 Q100 123 108 118" {...ROUND} stroke="#3A2A2E" strokeWidth="3" />
  </Portrait>
)

const DianaAvatar = ({ className }) => (
  <Portrait bg="#E5EEE9" className={className}>
    <path d="M56 96 Q48 42 100 40 Q152 42 144 96 Q150 130 156 166 Q100 180 44 166 Q50 130 56 96 Z" fill="#3A2A2E" />
    <path d="M30 200 Q34 152 100 148 Q166 152 170 200 Z" fill="#A8455E" />
    <path d="M78 150 Q100 166 122 150" fill="#B87A54" />
    <rect x="89" y="122" width="22" height="30" rx="8" fill="#AD7049" />
    <circle cx="63" cy="112" r="5" fill="none" stroke="#D9A441" strokeWidth="2.6" />
    <circle cx="137" cy="112" r="5" fill="none" stroke="#D9A441" strokeWidth="2.6" />
    <ellipse cx="100" cy="94" rx="36" ry="42" fill="#B87A54" />
    <path d="M63 94 Q60 52 104 48 Q86 62 78 96 Z" fill="#3A2A2E" />
    <path d="M100 48 Q140 50 138 94 Q128 64 100 57 Z" fill="#3A2A2E" />
    <path d="M81 97 q5 -6 10 0" {...ROUND} stroke="#3A2A2E" strokeWidth="3.6" />
    <path d="M109 97 q5 -6 10 0" {...ROUND} stroke="#3A2A2E" strokeWidth="3.6" />
    <circle cx="75" cy="109" r="6" fill="#E58FA3" />
    <circle cx="125" cy="109" r="6" fill="#E58FA3" />
    <path d="M87 113 Q100 130 113 113 Z" fill="#7A2E40" />
    <path d="M89 114 Q100 118 111 114 L110 117 Q100 121 90 117 Z" fill="#FFFFFF" />
  </Portrait>
)

const AVATARS = { daniel: DanielAvatar, oscar: OscarAvatar, victoria: VictoriaAvatar, diana: DianaAvatar }

/** Avatar for a host id (unknown ids get Daniel's). */
export function HostAvatar({ id, className }) {
  const Avatar = AVATARS[id] || DanielAvatar
  return <Avatar className={className} />
}
