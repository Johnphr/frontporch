// Landing illustrations, part 1 (hero, the three steps, what you need, promises).
// Flat shapes, no outlines. All decorative except the hero, which gets a label.

// Sound waves pulse gently (the second one a beat later); off with reduced motion.
const WAVE = 'motion-safe:animate-ring'
const WAVE_LATE = 'motion-safe:animate-ring motion-safe:[animation-delay:0.4s]'
const waveStroke = { fill: 'none', stroke: '#A8475E', strokeWidth: 4, strokeLinecap: 'round' }

/** Decorative SVG that scales to its container's width. */
export function Deco({ viewBox, className = 'block h-auto w-full', children }) {
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

/** Older woman on a sofa, on the phone, with a lamp and a plant. */
export function HeroArt({ label }) {
  return (
    <svg viewBox="0 0 560 420" className="block h-auto w-full" role="img" aria-label={label}>
      <circle cx="300" cy="200" r="180" fill="#F7D6DE" />
      <circle cx="80" cy="140" r="62" fill="#FFFFFF" opacity="0.7" />
      <path d="M48 160 L112 160 L97 108 L63 108 Z" fill="#F2B8C6" />
      <rect x="77" y="160" width="6" height="200" fill="#5B474C" />
      <ellipse cx="80" cy="362" rx="30" ry="7" fill="#5B474C" />
      <ellipse cx="482" cy="248" rx="15" ry="46" fill="#8FAE9B" transform="rotate(-24 482 292)" />
      <ellipse cx="514" cy="248" rx="15" ry="46" fill="#6F9180" transform="rotate(16 514 292)" />
      <ellipse cx="498" cy="234" rx="15" ry="52" fill="#8FAE9B" />
      <path d="M468 288 H528 L520 360 H476 Z" fill="#D88A9C" />
      <ellipse cx="290" cy="372" rx="215" ry="12" fill="#3A2A2E" opacity="0.08" />
      <rect x="130" y="196" width="320" height="140" rx="44" fill="#8FAE9B" />
      <rect x="150" y="342" width="12" height="26" rx="4" fill="#5B474C" />
      <rect x="418" y="342" width="12" height="26" rx="4" fill="#5B474C" />
      <rect x="146" y="280" width="288" height="64" rx="22" fill="#A6C1B0" />
      <rect x="110" y="250" width="58" height="100" rx="28" fill="#6F9180" />
      <rect x="412" y="250" width="58" height="100" rx="28" fill="#6F9180" />
      <ellipse cx="196" cy="248" rx="30" ry="36" fill="#F2B8C6" />
      <circle cx="232" cy="118" r="14" fill="#EDE9EA" />
      <rect x="218" y="170" width="80" height="122" rx="36" fill="#A8475E" />
      <rect x="250" y="262" width="126" height="40" rx="20" fill="#5B474C" />
      <rect x="346" y="278" width="34" height="90" rx="17" fill="#5B474C" />
      <ellipse cx="374" cy="366" rx="26" ry="10" fill="#3A2A2E" />
      <rect x="268" y="244" width="72" height="22" rx="11" fill="#A8475E" />
      <circle cx="340" cy="255" r="11" fill="#D9A07E" />
      <rect x="250" y="150" width="20" height="28" rx="8" fill="#D9A07E" />
      <circle cx="257" cy="126" r="34" fill="#EDE9EA" />
      <circle cx="263" cy="134" r="30" fill="#D9A07E" />
      <circle cx="282" cy="130" r="3" fill="#3A2A2E" />
      <circle cx="285" cy="145" r="6" fill="#F2B8C6" opacity="0.8" />
      <rect x="246" y="116" width="18" height="40" rx="5" fill="#3A2A2E" />
      <rect x="250" y="174" width="75" height="24" rx="12" fill="#A8475E" transform="rotate(42 262 186)" />
      <rect x="288" y="208" width="101" height="24" rx="12" fill="#A8475E" transform="rotate(-121 300 220)" />
      <circle cx="260" cy="154" r="12" fill="#D9A07E" />
      <path className={WAVE} d="M228 116 Q218 136 228 156" {...waveStroke} />
      <path className={WAVE_LATE} d="M214 106 Q198 136 214 166" {...waveStroke} />
    </svg>
  )
}

/** Step 1: someone at a laptop. */
export function SignUpArt() {
  return (
    <Deco viewBox="0 0 320 240">
      <circle cx="160" cy="120" r="110" fill="#FFFFFF" />
      <ellipse cx="160" cy="216" rx="120" ry="8" fill="#3A2A2E" opacity="0.08" />
      <rect x="118" y="96" width="84" height="100" rx="38" fill="#8FAE9B" />
      <rect x="98" y="118" width="22" height="52" rx="11" fill="#8FAE9B" />
      <rect x="200" y="118" width="22" height="52" rx="11" fill="#8FAE9B" />
      <rect x="152" y="84" width="16" height="18" rx="6" fill="#A9714F" />
      <circle cx="160" cy="64" r="30" fill="#3A2A2E" />
      <circle cx="160" cy="70" r="26" fill="#A9714F" />
      <path d="M134 68 A26 26 0 0 1 186 68 Q160 56 134 68 Z" fill="#3A2A2E" />
      <circle cx="151" cy="74" r="2.5" fill="#3A2A2E" />
      <circle cx="169" cy="74" r="2.5" fill="#3A2A2E" />
      <rect x="40" y="172" width="240" height="14" rx="7" fill="#D88A9C" />
      <rect x="60" y="186" width="10" height="30" rx="3" fill="#5B474C" />
      <rect x="250" y="186" width="10" height="30" rx="3" fill="#5B474C" />
      <rect x="112" y="114" width="96" height="58" rx="6" fill="#5B474C" />
      <circle cx="160" cy="143" r="5" fill="#F2B8C6" />
      <rect x="100" y="168" width="120" height="8" rx="4" fill="#3A2A2E" />
      <circle cx="108" cy="166" r="10" fill="#A9714F" />
      <circle cx="212" cy="166" r="10" fill="#A9714F" />
      <rect x="56" y="148" width="22" height="24" rx="5" fill="#8FAE9B" />
      <rect x="236" y="162" width="24" height="10" rx="3" fill="#3A2A2E" />
    </Deco>
  )
}

/** Step 2: an older man standing, on the phone. */
export function CallArt() {
  return (
    <Deco viewBox="0 0 320 260">
      <circle cx="160" cy="125" r="112" fill="#FFFFFF" />
      <ellipse cx="160" cy="240" rx="64" ry="8" fill="#3A2A2E" opacity="0.1" />
      <rect x="138" y="160" width="20" height="78" rx="10" fill="#5B474C" />
      <rect x="162" y="160" width="20" height="78" rx="10" fill="#5B474C" />
      <ellipse cx="146" cy="238" rx="15" ry="7" fill="#3A2A2E" />
      <ellipse cx="176" cy="238" rx="15" ry="7" fill="#3A2A2E" />
      <rect x="126" y="92" width="68" height="86" rx="30" fill="#6F9180" />
      <rect x="114" y="100" width="20" height="70" rx="10" fill="#6F9180" transform="rotate(8 124 108)" />
      <circle cx="115" cy="172" r="10" fill="#7A4E3A" />
      <rect x="152" y="78" width="16" height="20" rx="6" fill="#7A4E3A" />
      <circle cx="160" cy="62" r="26" fill="#EDE9EA" />
      <circle cx="160" cy="68" r="24" fill="#7A4E3A" />
      <path d="M138 74 Q160 104 182 74 Q160 86 138 74 Z" fill="#EDE9EA" />
      <circle cx="152" cy="66" r="2.5" fill="#241A1C" />
      <circle cx="168" cy="66" r="2.5" fill="#241A1C" />
      <rect x="180" y="50" width="14" height="34" rx="4" fill="#3A2A2E" />
      <rect x="178" y="92" width="66" height="20" rx="10" fill="#6F9180" transform="rotate(56 188 102)" />
      <rect x="204" y="130" width="92" height="20" rx="10" fill="#6F9180" transform="rotate(-113 214 140)" />
      <circle cx="186" cy="76" r="10" fill="#7A4E3A" />
      <path className={WAVE} d="M206 52 Q216 67 206 82" {...waveStroke} />
      <path className={WAVE_LATE} d="M220 42 Q236 67 220 92" {...waveStroke} />
    </Deco>
  )
}

/** Step 3: a phone and chat bubble turning into a post card. */
export function PostArt() {
  return (
    <Deco viewBox="0 0 320 240">
      <circle cx="160" cy="120" r="110" fill="#FFFFFF" />
      <rect x="40" y="82" width="64" height="110" rx="12" fill="#5B474C" />
      <rect x="48" y="94" width="48" height="78" rx="6" fill="#F2B8C6" />
      <circle cx="72" cy="182" r="4" fill="#F2B8C6" />
      <rect x="56" y="30" width="86" height="44" rx="22" fill="#8FAE9B" />
      <path d="M76 70 L70 90 L92 72 Z" fill="#8FAE9B" />
      <circle cx="84" cy="52" r="5" fill="#FFFFFF" />
      <circle cx="99" cy="52" r="5" fill="#FFFFFF" />
      <circle cx="114" cy="52" r="5" fill="#FFFFFF" />
      <circle cx="120" cy="132" r="4" fill="#D88A9C" />
      <circle cx="134" cy="132" r="4" fill="#D88A9C" />
      <circle cx="148" cy="132" r="4" fill="#D88A9C" />
      <rect x="162" y="60" width="128" height="140" rx="14" fill="#FCEEF1" />
      <circle cx="186" cy="88" r="14" fill="#F2B8C6" />
      <circle cx="186" cy="86" r="7" fill="#C9C3C5" />
      <circle cx="186" cy="88" r="6" fill="#D9A07E" />
      <rect x="208" y="80" width="60" height="8" rx="4" fill="#3A2A2E" opacity="0.55" />
      <rect x="208" y="94" width="40" height="6" rx="3" fill="#3A2A2E" opacity="0.25" />
      <rect x="176" y="116" width="100" height="8" rx="4" fill="#B9CFC1" />
      <rect x="176" y="132" width="90" height="8" rx="4" fill="#B9CFC1" />
      <rect x="176" y="148" width="98" height="8" rx="4" fill="#B9CFC1" />
      <rect x="176" y="164" width="66" height="8" rx="4" fill="#B9CFC1" />
      <circle cx="182" cy="184" r="5" fill="#A8475E" />
      <circle cx="196" cy="184" r="5" fill="#F2B8C6" />
    </Deco>
  )
}

/** What you need: an old rotary phone and a cup of tea. */
export function NeedArt() {
  return (
    <Deco viewBox="0 0 320 240">
      <circle cx="160" cy="118" r="108" fill="#F7D6DE" />
      <ellipse cx="170" cy="204" rx="120" ry="9" fill="#3A2A2E" opacity="0.08" />
      <path d="M88 202 L232 202 L214 122 L106 122 Z" fill="#A8475E" />
      <circle cx="160" cy="164" r="28" fill="#FCEEF1" />
      <circle cx="160" cy="145" r="4" fill="#D88A9C" />
      <circle cx="177" cy="155" r="4" fill="#D88A9C" />
      <circle cx="177" cy="174" r="4" fill="#D88A9C" />
      <circle cx="143" cy="174" r="4" fill="#D88A9C" />
      <circle cx="143" cy="155" r="4" fill="#D88A9C" />
      <circle cx="160" cy="164" r="9" fill="#F2B8C6" />
      <rect x="112" y="110" width="96" height="16" rx="8" fill="#5B474C" />
      <rect x="94" y="86" width="132" height="22" rx="11" fill="#3A2A2E" />
      <ellipse cx="100" cy="102" rx="22" ry="14" fill="#3A2A2E" />
      <ellipse cx="220" cy="102" rx="22" ry="14" fill="#3A2A2E" />
      <ellipse cx="262" cy="202" rx="28" ry="6" fill="#6F9180" />
      <path d="M244 172 H280 V184 A18 18 0 0 1 244 184 Z" fill="#8FAE9B" />
      <rect x="278" y="176" width="12" height="14" rx="6" fill="#8FAE9B" />
    </Deco>
  )
}

/** Promises: a woman holding a checklist. */
export function PromiseArt() {
  return (
    <Deco viewBox="0 0 320 260">
      <circle cx="160" cy="125" r="112" fill="#E6EEE9" />
      <ellipse cx="160" cy="240" rx="64" ry="8" fill="#3A2A2E" opacity="0.1" />
      <rect x="138" y="160" width="20" height="78" rx="10" fill="#5B474C" />
      <rect x="162" y="160" width="20" height="78" rx="10" fill="#5B474C" />
      <ellipse cx="146" cy="238" rx="15" ry="7" fill="#3A2A2E" />
      <ellipse cx="176" cy="238" rx="15" ry="7" fill="#3A2A2E" />
      <rect x="124" y="92" width="72" height="88" rx="30" fill="#F2B8C6" />
      <rect x="112" y="98" width="20" height="58" rx="10" fill="#F2B8C6" />
      <rect x="188" y="98" width="20" height="58" rx="10" fill="#F2B8C6" />
      <rect x="116" y="138" width="44" height="20" rx="10" fill="#F2B8C6" />
      <rect x="160" y="138" width="44" height="20" rx="10" fill="#F2B8C6" />
      <rect x="128" y="108" width="64" height="80" rx="6" fill="#FFFFFF" />
      <rect x="148" y="102" width="24" height="10" rx="3" fill="#5B474C" />
      <circle cx="140" cy="128" r="5" fill="#8FAE9B" />
      <rect x="150" y="125" width="32" height="6" rx="3" fill="#CFDDD4" />
      <circle cx="140" cy="148" r="5" fill="#8FAE9B" />
      <rect x="150" y="145" width="28" height="6" rx="3" fill="#CFDDD4" />
      <circle cx="140" cy="168" r="5" fill="#8FAE9B" />
      <rect x="150" y="165" width="32" height="6" rx="3" fill="#CFDDD4" />
      <circle cx="128" cy="150" r="10" fill="#E8B994" />
      <circle cx="192" cy="150" r="10" fill="#E8B994" />
      <rect x="152" y="78" width="16" height="20" rx="6" fill="#E8B994" />
      <circle cx="160" cy="62" r="26" fill="#C9C3C5" />
      <circle cx="160" cy="68" r="24" fill="#E8B994" />
      <path d="M136 66 A24 24 0 0 1 184 66 Q166 52 136 66 Z" fill="#C9C3C5" />
      <circle cx="152" cy="70" r="2.5" fill="#3A2A2E" />
      <circle cx="168" cy="70" r="2.5" fill="#3A2A2E" />
    </Deco>
  )
}

/** Rose circle with a white tick, for the promises list. */
export function CheckIcon() {
  return (
    <Deco viewBox="0 0 32 32" className="mt-0.5 block h-11 w-11">
      <circle cx="16" cy="16" r="16" fill="#A8475E" />
      <path d="M9 16.5 L13.5 21 L23 11.5" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </Deco>
  )
}
