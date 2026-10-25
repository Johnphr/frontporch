// Flat illustrations and icons for sign-in and setup (design-mockups/login-c.html, onboarding-c.html).
// All decorative (aria-hidden) except ReadingArt, which takes a label. Waves pulse (motion-safe only).

const WAVE = 'motion-safe:animate-ring'
const WAVE_LATE = 'motion-safe:animate-ring [animation-delay:0.4s]'

function Svg({ viewBox, className, children }) {
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

// Icons
export const BackChevron = ({ className = 'h-5 w-5' }) => (
  <Svg viewBox="0 0 20 20" className={className}>
    <path d="M12.5 4 L6.5 10 L12.5 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
)

export const PhoneIcon = ({ className = 'h-7 w-7 flex-none' }) => (
  <Svg viewBox="0 0 24 24" className={className}>
    <rect x="6" y="2.5" width="12" height="19" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
    <circle cx="12" cy="17.5" r="1.4" fill="currentColor" />
  </Svg>
)

export const MailIcon = ({ className = 'h-7 w-7 flex-none' }) => (
  <Svg viewBox="0 0 24 24" className={className}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M3.5 6.5 L12 13 L20.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
  </Svg>
)

/** Round check mark: sage (done) or rose (lists). */
export const CheckMark = ({ className = 'h-10 w-10 flex-none', fill = '#A8475E' }) => (
  <Svg viewBox="0 0 32 32" className={className}>
    <circle cx="16" cy="16" r="16" fill={fill} />
    <path d="M9 16.5 L13.5 21 L23 11.5" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
)

export const ClockIcon = ({ className = 'h-10 w-10 flex-none' }) => (
  <Svg viewBox="0 0 32 32" className={className}>
    <circle cx="16" cy="16" r="16" fill="#8FAE9B" />
    <rect x="14.5" y="7" width="3" height="10.5" rx="1.5" fill="#FFFFFF" />
    <rect x="14.5" y="14.5" width="8.5" height="3" rx="1.5" fill="#FFFFFF" />
  </Svg>
)

// Sign in
/** Older man at a table reading his phone, coffee steaming. */
export function ReadingArt({ className, label }) {
  return (
    <svg viewBox="0 0 360 320" className={className} role="img" aria-label={label}>
      <circle cx="180" cy="150" r="140" fill="#F7D6DE" />
      <circle cx="296" cy="56" r="30" fill="#FFFFFF" opacity="0.7" />
      <ellipse cx="180" cy="300" rx="150" ry="10" fill="#3A2A2E" opacity="0.08" />
      <rect x="116" y="124" width="128" height="120" rx="34" fill="#6F9180" />
      <rect x="138" y="140" width="84" height="104" rx="36" fill="#A8475E" />
      <rect x="130" y="150" width="22" height="66" rx="11" fill="#A8475E" />
      <rect x="208" y="150" width="22" height="66" rx="11" fill="#A8475E" />
      <rect x="172" y="120" width="16" height="24" rx="6" fill="#A9714F" />
      <circle cx="180" cy="94" r="32" fill="#EDE9EA" />
      <circle cx="182" cy="100" r="28" fill="#A9714F" />
      <path d="M154 98 A28 28 0 0 1 210 98 Q188 82 154 98 Z" fill="#EDE9EA" />
      <circle cx="176" cy="104" r="2.6" fill="#3A2A2E" /><circle cx="194" cy="104" r="2.6" fill="#3A2A2E" />
      <circle cx="201" cy="115" r="5" fill="#F2B8C6" opacity="0.8" />
      <rect x="40" y="232" width="280" height="16" rx="8" fill="#D88A9C" />
      <rect x="62" y="248" width="10" height="50" rx="3" fill="#5B474C" />
      <rect x="288" y="248" width="10" height="50" rx="3" fill="#5B474C" />
      <rect x="56" y="208" width="14" height="16" rx="7" fill="#6F9180" />
      <rect x="64" y="196" width="34" height="36" rx="8" fill="#8FAE9B" />
      <path className={WAVE} d="M76 186 Q70 176 76 166" fill="none" stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" />
      <path className={WAVE_LATE} d="M88 186 Q82 176 88 166" fill="none" stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" />
      <rect x="104" y="210" width="50" height="22" rx="11" fill="#A8475E" />
      <circle cx="108" cy="221" r="11" fill="#A9714F" />
      <rect x="208" y="200" width="58" height="22" rx="11" fill="#A8475E" transform="rotate(-55 219 211)" />
      <rect x="230" y="134" width="30" height="50" rx="6" fill="#5B474C" />
      <rect x="234" y="140" width="22" height="32" rx="3" fill="#F2B8C6" />
      <rect x="237" y="152" width="16" height="4" rx="2" fill="#FFFFFF" />
      <circle cx="242" cy="180" r="11" fill="#A9714F" />
    </svg>
  )
}

/** Envelope with a check badge ("Check your email"). */
export const EmailSentArt = ({ className }) => (
  <Svg viewBox="0 0 240 180" className={className}>
    <circle cx="120" cy="88" r="82" fill="#F7D6DE" />
    <ellipse cx="120" cy="164" rx="84" ry="7" fill="#3A2A2E" opacity="0.08" />
    <rect x="46" y="58" width="148" height="98" rx="12" fill="#FFFFFF" />
    <path d="M50 154 L106 106 L120 116 L134 106 L190 154 Z" fill="#FCEEF1" />
    <path d="M46 70 A12 12 0 0 1 58 58 H182 A12 12 0 0 1 194 70 L120 120 Z" fill="#F2B8C6" />
    <circle cx="186" cy="58" r="20" fill="#A8475E" />
    <path d="M177 58.5 L183.5 65 L196 52" fill="none" stroke="#FFFFFF" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
)

// Setup steps
/** Step 1: a house with a porch. */
export const PorchArt = ({ className }) => (
  <Svg viewBox="0 0 360 240" className={className}>
    <circle cx="180" cy="130" r="104" fill="#F7D6DE" />
    <ellipse cx="180" cy="222" rx="150" ry="9" fill="#3A2A2E" opacity="0.08" />
    <rect x="80" y="100" width="200" height="118" fill="#FFFFFF" />
    <path d="M62 106 L180 40 L298 106 Z" fill="#A8475E" />
    <rect x="72" y="126" width="216" height="12" rx="4" fill="#D88A9C" />
    <rect x="86" y="138" width="9" height="78" fill="#FCEEF1" />
    <rect x="265" y="138" width="9" height="78" fill="#FCEEF1" />
    <rect x="108" y="152" width="38" height="30" rx="4" fill="#F2B8C6" />
    <rect x="214" y="152" width="38" height="30" rx="4" fill="#F2B8C6" />
    <rect x="162" y="146" width="36" height="70" rx="4" fill="#8FAE9B" />
    <circle cx="190" cy="184" r="3" fill="#FCEEF1" />
    <circle cx="180" cy="76" r="10" fill="#F2B8C6" />
    <rect x="76" y="214" width="208" height="8" rx="3" fill="#6F9180" />
  </Svg>
)

/** Step 1 choice: one person. */
export const SelfAvatar = ({ className }) => (
  <Svg viewBox="0 0 72 72" className={className}>
    <rect width="72" height="72" fill="#F7D6DE" />
    <path d="M12 72 A24 22 0 0 1 60 72 Z" fill="#A8475E" />
    <circle cx="36" cy="27" r="16" fill="#C9C3C5" />
    <circle cx="36" cy="31" r="13" fill="#A9714F" />
    <circle cx="31" cy="31" r="1.6" fill="#3A2A2E" /><circle cx="41" cy="31" r="1.6" fill="#3A2A2E" />
  </Svg>
)

/** Step 1 choice: two people. */
export const HelperAvatar = ({ className }) => (
  <Svg viewBox="0 0 72 72" className={className}>
    <rect width="72" height="72" fill="#E6EEE9" />
    <path d="M4 72 A20 18 0 0 1 44 72 Z" fill="#A8475E" />
    <circle cx="24" cy="34" r="12" fill="#EDE9EA" />
    <circle cx="24" cy="37" r="10" fill="#F3CBB0" />
    <circle cx="20.5" cy="37" r="1.4" fill="#3A2A2E" /><circle cx="27.5" cy="37" r="1.4" fill="#3A2A2E" />
    <path d="M30 72 A20 18 0 0 1 70 72 Z" fill="#6F9180" />
    <circle cx="50" cy="30" r="12" fill="#3A2A2E" />
    <circle cx="50" cy="33" r="10" fill="#7A4E3A" />
    <circle cx="46.5" cy="33" r="1.4" fill="#241A1C" /><circle cx="53.5" cy="33" r="1.4" fill="#241A1C" />
  </Svg>
)

/** Step 2: a person with a name tag and a speech bubble. */
export const NameArt = ({ className }) => (
  <Svg viewBox="0 0 320 220" className={className}>
    <circle cx="160" cy="112" r="100" fill="#FCEEF1" />
    <ellipse cx="146" cy="206" rx="70" ry="7" fill="#3A2A2E" opacity="0.08" />
    <rect x="100" y="120" width="80" height="86" rx="34" fill="#6F9180" />
    <rect x="176" y="92" width="20" height="56" rx="10" fill="#6F9180" transform="rotate(18 186 148)" />
    <circle cx="204" cy="92" r="10" fill="#E8B994" />
    <rect x="118" y="142" width="44" height="24" rx="4" fill="#FFFFFF" />
    <rect x="124" y="151" width="32" height="6" rx="3" fill="#A8475E" />
    <rect x="132" y="104" width="16" height="20" rx="6" fill="#E8B994" />
    <circle cx="140" cy="86" r="28" fill="#C9C3C5" />
    <circle cx="140" cy="92" r="25" fill="#E8B994" />
    <path d="M115 90 A25 25 0 0 1 165 90 Q145 76 115 90 Z" fill="#C9C3C5" />
    <circle cx="131" cy="95" r="2.5" fill="#3A2A2E" /><circle cx="149" cy="95" r="2.5" fill="#3A2A2E" />
    <rect x="24" y="30" width="96" height="44" rx="22" fill="#F2B8C6" />
    <path d="M92 70 L104 88 L80 72 Z" fill="#F2B8C6" />
    <rect x="42" y="46" width="60" height="7" rx="3.5" fill="#FFFFFF" />
    <rect x="42" y="58" width="40" height="7" rx="3.5" fill="#FFFFFF" opacity="0.75" />
  </Svg>
)

/** Step 3: two speech bubbles. */
export const LanguageArt = ({ className }) => (
  <Svg viewBox="0 0 320 200" className={className}>
    <circle cx="160" cy="100" r="92" fill="#FCEEF1" />
    <rect x="44" y="40" width="140" height="60" rx="30" fill="#F2B8C6" />
    <path d="M76 94 L66 118 L98 98 Z" fill="#F2B8C6" />
    <rect x="72" y="60" width="84" height="8" rx="4" fill="#FFFFFF" />
    <rect x="72" y="74" width="56" height="8" rx="4" fill="#FFFFFF" opacity="0.75" />
    <rect x="136" y="106" width="140" height="60" rx="30" fill="#8FAE9B" />
    <path d="M244 160 L256 184 L224 166 Z" fill="#8FAE9B" />
    <rect x="164" y="126" width="84" height="8" rx="4" fill="#FFFFFF" />
    <rect x="164" y="140" width="60" height="8" rx="4" fill="#FFFFFF" opacity="0.75" />
  </Svg>
)

/** Step 3 host card: Pip (rose, sound-wave smile) and Juanito (sage, bow tie). */
export const PipHost = ({ className }) => (
  <Svg viewBox="0 0 120 120" className={className}>
    <ellipse cx="60" cy="112" rx="34" ry="5" fill="#3A2A2E" opacity="0.1" />
    <circle cx="60" cy="58" r="46" fill="#A8475E" />
    <circle cx="60" cy="64" r="34" fill="#F7D6DE" />
    <circle cx="48" cy="58" r="4" fill="#3A2A2E" /><circle cx="72" cy="58" r="4" fill="#3A2A2E" />
    <path d="M42 76 q4.5 -6 9 0 t9 0 t9 0 t9 0" fill="none" stroke="#A8475E" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    <path className={WAVE} d="M110 46 Q117 58 110 70" fill="none" stroke="#A8475E" strokeWidth="4" strokeLinecap="round" />
  </Svg>
)

export const JuanitoHost = ({ className }) => (
  <Svg viewBox="0 0 120 120" className={className}>
    <ellipse cx="60" cy="114" rx="34" ry="5" fill="#3A2A2E" opacity="0.1" />
    <circle cx="60" cy="56" r="44" fill="#8FAE9B" />
    <circle cx="60" cy="60" r="32" fill="#E6EEE9" />
    <circle cx="49" cy="56" r="4" fill="#3A2A2E" /><circle cx="71" cy="56" r="4" fill="#3A2A2E" />
    <path d="M50 70 Q60 78 70 70" fill="none" stroke="#3A2A2E" strokeWidth="3.5" strokeLinecap="round" />
    <path d="M60 102 L43 93 L43 111 Z" fill="#A8475E" />
    <path d="M60 102 L77 93 L77 111 Z" fill="#A8475E" />
    <circle cx="60" cy="102" r="5" fill="#5B474C" />
  </Svg>
)

/** Step 4: a calendar and a clock. */
export const CalendarArt = ({ className }) => (
  <Svg viewBox="0 0 320 200" className={className}>
    <circle cx="160" cy="100" r="92" fill="#E6EEE9" />
    <ellipse cx="160" cy="188" rx="110" ry="7" fill="#3A2A2E" opacity="0.08" />
    <rect x="62" y="56" width="120" height="124" rx="14" fill="#FFFFFF" />
    <rect x="62" y="56" width="120" height="30" rx="14" fill="#A8475E" />
    <rect x="62" y="72" width="120" height="14" fill="#A8475E" />
    <rect x="86" y="44" width="10" height="24" rx="5" fill="#5B474C" />
    <rect x="148" y="44" width="10" height="24" rx="5" fill="#5B474C" />
    <circle cx="84" cy="108" r="6" fill="#F7D6DE" /><circle cx="106" cy="108" r="6" fill="#F7D6DE" /><circle cx="128" cy="108" r="6" fill="#F7D6DE" />
    <circle cx="84" cy="132" r="6" fill="#F7D6DE" /><circle cx="106" cy="132" r="9" fill="#A8475E" /><circle cx="128" cy="132" r="6" fill="#F7D6DE" />
    <circle cx="84" cy="156" r="6" fill="#F7D6DE" /><circle cx="106" cy="156" r="6" fill="#F7D6DE" />
    <circle cx="222" cy="128" r="48" fill="#F2B8C6" />
    <circle cx="222" cy="128" r="38" fill="#FFFFFF" />
    <rect x="219" y="98" width="6" height="33" rx="3" fill="#3A2A2E" />
    <rect x="219" y="106" width="6" height="25" rx="3" fill="#3A2A2E" transform="rotate(-30 222 128)" />
    <circle cx="222" cy="128" r="5" fill="#A8475E" />
  </Svg>
)

/** Step 5: a profile page. */
export const ProfileArt = ({ className }) => (
  <Svg viewBox="0 0 320 200" className={className}>
    <circle cx="160" cy="100" r="92" fill="#FCEEF1" />
    <ellipse cx="160" cy="190" rx="100" ry="7" fill="#3A2A2E" opacity="0.08" />
    <rect x="86" y="26" width="148" height="158" rx="16" fill="#FFFFFF" />
    <circle cx="114" cy="58" r="16" fill="#F2B8C6" />
    <circle cx="114" cy="55" r="8" fill="#C9C3C5" />
    <circle cx="114" cy="58" r="7" fill="#D9A07E" />
    <rect x="138" y="50" width="72" height="8" rx="4" fill="#3A2A2E" opacity="0.55" />
    <rect x="138" y="64" width="48" height="6" rx="3" fill="#3A2A2E" opacity="0.25" />
    <rect x="104" y="90" width="112" height="8" rx="4" fill="#B9CFC1" />
    <rect x="104" y="106" width="100" height="8" rx="4" fill="#B9CFC1" />
    <rect x="104" y="122" width="108" height="8" rx="4" fill="#B9CFC1" />
    <rect x="104" y="138" width="76" height="8" rx="4" fill="#B9CFC1" />
    <circle cx="110" cy="164" r="6" fill="#A8475E" />
    <circle cx="126" cy="164" r="6" fill="#F2B8C6" />
    <rect x="170" y="156" width="48" height="16" rx="8" fill="#F7D6DE" />
  </Svg>
)

/** Step 6: a clipboard checklist. */
export const ClipboardArt = ({ className }) => (
  <Svg viewBox="0 0 320 200" className={className}>
    <circle cx="160" cy="100" r="92" fill="#E6EEE9" />
    <ellipse cx="160" cy="190" rx="80" ry="7" fill="#3A2A2E" opacity="0.08" />
    <rect x="104" y="30" width="112" height="152" rx="14" fill="#F2B8C6" />
    <rect x="116" y="46" width="88" height="124" rx="6" fill="#FFFFFF" />
    <rect x="140" y="22" width="40" height="18" rx="6" fill="#5B474C" />
    <circle cx="132" cy="74" r="7" fill="#8FAE9B" /><rect x="146" y="70" width="44" height="8" rx="4" fill="#CFDDD4" />
    <circle cx="132" cy="102" r="7" fill="#8FAE9B" /><rect x="146" y="98" width="38" height="8" rx="4" fill="#CFDDD4" />
    <circle cx="132" cy="130" r="7" fill="#8FAE9B" /><rect x="146" y="126" width="44" height="8" rx="4" fill="#CFDDD4" />
    <circle cx="132" cy="158" r="7" fill="#A8475E" /><rect x="146" y="154" width="30" height="8" rx="4" fill="#CFDDD4" />
  </Svg>
)

/** Done: a ringing phone on a side table, lamp and teacup. */
export const RingingArt = ({ className }) => (
  <Svg viewBox="0 0 360 280" className={className}>
    <circle cx="180" cy="130" r="118" fill="#F7D6DE" />
    <ellipse cx="180" cy="264" rx="140" ry="9" fill="#3A2A2E" opacity="0.08" />
    <rect x="40" y="170" width="280" height="16" rx="8" fill="#D88A9C" />
    <rect x="60" y="186" width="12" height="76" rx="4" fill="#5B474C" />
    <rect x="288" y="186" width="12" height="76" rx="4" fill="#5B474C" />
    <rect x="66" y="226" width="228" height="10" rx="4" fill="#D88A9C" />
    <ellipse cx="84" cy="168" rx="20" ry="6" fill="#5B474C" />
    <rect x="81" y="104" width="6" height="64" fill="#5B474C" />
    <path d="M58 108 H110 L100 68 H68 Z" fill="#FFFFFF" />
    <path d="M150 170 L250 170 L236 116 L164 116 Z" fill="#A8475E" />
    <circle cx="200" cy="145" r="20" fill="#FCEEF1" />
    <circle cx="200" cy="132" r="3" fill="#D88A9C" /><circle cx="212" cy="140" r="3" fill="#D88A9C" /><circle cx="210" cy="154" r="3" fill="#D88A9C" />
    <circle cx="190" cy="154" r="3" fill="#D88A9C" /><circle cx="188" cy="140" r="3" fill="#D88A9C" />
    <circle cx="200" cy="145" r="7" fill="#F2B8C6" />
    <rect x="168" y="102" width="64" height="14" rx="7" fill="#5B474C" />
    <rect x="154" y="88" width="92" height="18" rx="9" fill="#3A2A2E" />
    <ellipse cx="160" cy="102" rx="16" ry="11" fill="#3A2A2E" />
    <ellipse cx="240" cy="102" rx="16" ry="11" fill="#3A2A2E" />
    <path className={WAVE} d="M142 70 Q132 84 142 98" fill="none" stroke="#A8475E" strokeWidth="4" strokeLinecap="round" />
    <path className={WAVE_LATE} d="M128 62 Q114 84 128 106" fill="none" stroke="#A8475E" strokeWidth="4" strokeLinecap="round" />
    <path className={WAVE_LATE} d="M258 70 Q268 84 258 98" fill="none" stroke="#A8475E" strokeWidth="4" strokeLinecap="round" />
    <path className={WAVE_LATE} d="M272 62 Q286 84 272 106" fill="none" stroke="#A8475E" strokeWidth="4" strokeLinecap="round" />
    <path d="M266 146 H294 V156 A14 14 0 0 1 266 156 Z" fill="#8FAE9B" />
    <rect x="292" y="150" width="10" height="12" rx="5" fill="#8FAE9B" />
  </Svg>
)
