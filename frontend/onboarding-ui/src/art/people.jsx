// The people the landing page talks about, drawn like the host portraits (flat, no outlines, head
// and shoulders in a soft circle). `children` draw on top, inside the circle (a phone in hand).
//   Margaret (~70): silver bob, warm wide smile, laugh lines, rose cardigan over a white blouse.
//   Walter (~72): deep brown skin, grey receding hair, white moustache, glasses, green cardigan.
//   Helper (~40, their daughter): dark hair in a ponytail, pink sweater, friendly smile.
import { Portrait } from './hosts'

const ROUND = { fill: 'none', strokeLinecap: 'round' }
const SHOULDERS = 'M30 200 Q34 150 100 146 Q166 150 170 200 Z'

// Skin, skin shadow and sleeve, so a hand drawn on top (PhoneInHand) matches the person.
export const MARGARET_HAND = { skin: '#F3D3C0', shade: '#E3B39C', sleeve: '#C9677E' }
export const WALTER_HAND = { skin: '#6B4430', shade: '#4E3022', sleeve: '#557A68' }

export const MargaretAvatar = ({ className, children }) => (
  <Portrait bg="#FCE4E8" className={className}>
    <path d="M58 102 Q50 46 100 42 Q150 46 142 102 Q146 122 140 131 Q132 137 124 131 L76 131 Q68 137 60 131 Q54 122 58 102 Z" fill="#D6D0CE" />
    <path d={SHOULDERS} fill={MARGARET_HAND.sleeve} />
    <path d="M84 147 L100 172 L116 147 Z" fill="#FFFFFF" />
    <path d="M84 148 L95 200 M116 148 L105 200" {...ROUND} stroke="#B3566D" strokeWidth="5" />
    <circle cx="99" cy="184" r="2.6" fill="#FCE4E8" />
    <rect x="89" y="122" width="22" height="30" rx="8" fill="#E8BFA9" />
    <ellipse cx="100" cy="94" rx="36" ry="42" fill={MARGARET_HAND.skin} />
    <path d="M61 104 Q54 50 102 48 Q146 50 139 104 Q136 78 122 66 Q104 78 76 76 Q66 86 61 104 Z" fill="#E9E4E2" />
    <path d="M78 62 Q96 54 116 58" {...ROUND} stroke="#FFFFFF" strokeWidth="3" opacity="0.8" />
    <circle cx="86" cy="96" r="3.6" fill="#3A2A2E" />
    <circle cx="114" cy="96" r="3.6" fill="#3A2A2E" />
    <path d="M70 92 Q68 95 70 98 M130 92 Q132 95 130 98" {...ROUND} stroke="#E6B8A6" strokeWidth="1.8" />
    <circle cx="76" cy="111" r="5.5" fill="#F2A6B6" />
    <circle cx="124" cy="111" r="5.5" fill="#F2A6B6" />
    <path d="M88 114 Q100 127 112 114" {...ROUND} stroke="#3A2A2E" strokeWidth="3.2" />
    {children}
  </Portrait>
)

export const WalterAvatar = ({ className, children }) => (
  <Portrait bg="#FCE4E8" className={className}>
    <path d={SHOULDERS} fill={WALTER_HAND.sleeve} />
    <path d="M86 147 L100 178 L114 147 Z" fill="#FFFFFF" />
    <path d="M84 146 L93 164 L100 152 Z M116 146 L107 164 L100 152 Z" fill="#F3F0EF" />
    <path d="M86 149 L96 200 M114 149 L104 200" {...ROUND} stroke="#46685A" strokeWidth="5" />
    <circle cx="100" cy="188" r="2.6" fill="#E5EEE9" />
    <rect x="89" y="122" width="22" height="30" rx="8" fill="#5E3B29" />
    <g fill="#D6D0CE">
      <circle cx="67" cy="72" r="10" />
      <circle cx="60" cy="86" r="10" />
      <circle cx="60" cy="101" r="9" />
      <circle cx="133" cy="72" r="10" />
      <circle cx="140" cy="86" r="10" />
      <circle cx="140" cy="101" r="9" />
    </g>
    <ellipse cx="64" cy="100" rx="7" ry="11" fill="#5E3B29" />
    <ellipse cx="136" cy="100" rx="7" ry="11" fill="#5E3B29" />
    <ellipse cx="100" cy="94" rx="36" ry="42" fill={WALTER_HAND.skin} />
    <path d="M64 100 Q62 80 72 66 L77 70 Q69 84 69 100 Z M136 100 Q138 80 128 66 L123 70 Q131 84 131 100 Z" fill="#D6D0CE" />
    <path d="M84 63 Q96 56 108 58" {...ROUND} stroke="#80563F" strokeWidth="4" />
    <path d="M76 82 q8 -4 16 0 M108 82 q8 -4 16 0" {...ROUND} stroke="#E9E4E2" strokeWidth="3.4" />
    <circle cx="86" cy="96" r="3.6" fill="#241A1C" />
    <circle cx="114" cy="96" r="3.6" fill="#241A1C" />
    <rect x="73" y="87" width="25" height="19" rx="7" fill="none" stroke="#C9C1BF" strokeWidth="3" />
    <rect x="102" y="87" width="25" height="19" rx="7" fill="none" stroke="#C9C1BF" strokeWidth="3" />
    <path d="M98 95 Q100 93 102 95" fill="none" stroke="#C9C1BF" strokeWidth="3" />
    <path d="M82 108 Q78 116 82 123 M118 108 Q122 116 118 123" {...ROUND} stroke="#4E3022" strokeWidth="2" opacity="0.6" />
    <circle cx="75" cy="112" r="5" fill="#C9707F" opacity="0.6" />
    <circle cx="125" cy="112" r="5" fill="#C9707F" opacity="0.6" />
    <path d="M86 114 Q100 106 114 114 Q107 119 100 116 Q93 119 86 114 Z" fill="#E9E4E2" />
    <path d="M91 121 Q100 129 109 121" {...ROUND} stroke="#241A1C" strokeWidth="3.2" />
    {children}
  </Portrait>
)

export const HelperAvatar = ({ className, children }) => (
  <Portrait bg="#E5EEE9" className={className}>
    <path d="M82 50 Q36 52 42 102 Q44 128 54 140 Q58 112 70 90 Z" fill="#2E2226" />
    <path d={SHOULDERS} fill="#F2B8C6" />
    <path d="M80 148 Q100 162 120 148" {...ROUND} stroke="#E59FB1" strokeWidth="7" />
    <rect x="89" y="122" width="22" height="30" rx="8" fill="#96603F" />
    <ellipse cx="100" cy="94" rx="36" ry="42" fill="#A86E4C" />
    <path d="M63 96 Q58 48 100 47 Q142 48 137 96 Q134 70 112 62 Q102 66 92 63 Q68 68 63 96 Z" fill="#2E2226" />
    <circle cx="64" cy="56" r="6" fill="#A8455E" />
    <circle cx="64" cy="108" r="2.6" fill="#D9A441" />
    <circle cx="136" cy="108" r="2.6" fill="#D9A441" />
    <circle cx="86" cy="96" r="4" fill="#241A1C" />
    <circle cx="114" cy="96" r="4" fill="#241A1C" />
    <circle cx="76" cy="110" r="5.5" fill="#E58FA3" opacity="0.8" />
    <circle cx="124" cy="110" r="5.5" fill="#E58FA3" opacity="0.8" />
    <path d="M89 115 Q100 126 111 115" {...ROUND} stroke="#241A1C" strokeWidth="3.2" />
    {children}
  </Portrait>
)
