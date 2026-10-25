// Host avatars (flat, no outlines, palette colors only). Decorative: the host's name is always next to it.
//   Daniel: rose face, soft smile.  Oscar: sage face, wide grin, little rose cap.
//   Victoria: plum face, neat ink bob.  Diana: pink face, bright cheeks, a rose flower.

const Svg = ({ className = 'h-24 w-24', children }) => (
  <svg viewBox="0 0 72 72" className={className} aria-hidden="true" focusable="false">
    {children}
  </svg>
)

const DanielAvatar = ({ className }) => (
  <Svg className={className}>
    <circle cx="36" cy="36" r="36" fill="#F7D6DE" />
    <circle cx="36" cy="39" r="24" fill="#A8475E" />
    <path d="M22 30 Q28 17 44 18 Q52 19 52 26 Q42 22 22 30 Z" fill="#8E3A4F" />
    <circle cx="28" cy="36" r="3.2" fill="#FFFFFF" />
    <circle cx="44" cy="36" r="3.2" fill="#FFFFFF" />
    <path d="M28 46 Q36 52 44 46" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" />
  </Svg>
)

const OscarAvatar = ({ className }) => (
  <Svg className={className}>
    <circle cx="36" cy="36" r="36" fill="#E6EEE9" />
    <circle cx="36" cy="41" r="22" fill="#8FAE9B" />
    <path d="M15 35 A21 19 0 0 1 57 35 Z" fill="#A8475E" />
    <path d="M50 31 H63 A2.5 2.5 0 0 1 63 36 H50 Z" fill="#8E3A4F" />
    <circle cx="29" cy="41" r="2.8" fill="#3A2A2E" />
    <circle cx="43" cy="41" r="2.8" fill="#3A2A2E" />
    <path d="M25 48 Q36 62 47 48 Z" fill="#3A2A2E" />
    <path d="M28 49 H44 Q42 52 36 52 Q30 52 28 49 Z" fill="#FFFFFF" />
  </Svg>
)

const VictoriaAvatar = ({ className }) => (
  <Svg className={className}>
    <circle cx="36" cy="36" r="36" fill="#FCEEF1" />
    <circle cx="36" cy="36" r="24" fill="#3A2A2E" />
    <rect x="12" y="36" width="48" height="20" rx="9" fill="#3A2A2E" />
    <circle cx="36" cy="41" r="18" fill="#5B474C" />
    <path d="M18 38 C18 25 27 17 40 18 C35 24 27 32 18 38 Z" fill="#3A2A2E" />
    <circle cx="30" cy="40" r="2.6" fill="#FFFFFF" />
    <circle cx="42" cy="40" r="2.6" fill="#FFFFFF" />
    <path d="M31 48 Q36 51 41 48" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" />
    <circle cx="15" cy="50" r="2.4" fill="#F2B8C6" />
  </Svg>
)

const DianaAvatar = ({ className }) => (
  <Svg className={className}>
    <circle cx="36" cy="36" r="36" fill="#FCEEF1" />
    <circle cx="35" cy="40" r="23" fill="#F2B8C6" />
    <circle cx="27" cy="38" r="2.8" fill="#3A2A2E" />
    <circle cx="43" cy="38" r="2.8" fill="#3A2A2E" />
    <circle cx="22" cy="46" r="4" fill="#A8475E" opacity="0.45" />
    <circle cx="48" cy="46" r="4" fill="#A8475E" opacity="0.45" />
    <path d="M27 47 Q35 55 43 47" fill="none" stroke="#3A2A2E" strokeWidth="2.4" strokeLinecap="round" />
    <path d="M44 24 Q47 15 56 16 Q53 24 44 24 Z" fill="#8FAE9B" />
    <circle cx="54" cy="16" r="4" fill="#A8475E" />
    <circle cx="61" cy="20" r="4" fill="#A8475E" />
    <circle cx="59" cy="27" r="4" fill="#A8475E" />
    <circle cx="51" cy="26" r="4" fill="#A8475E" />
    <circle cx="49" cy="19" r="4" fill="#A8475E" />
    <circle cx="55" cy="22" r="3" fill="#FCEEF1" />
  </Svg>
)

const AVATARS = { daniel: DanielAvatar, oscar: OscarAvatar, victoria: VictoriaAvatar, diana: DianaAvatar }

/** Avatar for a host id (unknown ids get Daniel's). */
export function HostAvatar({ id, className }) {
  const Avatar = AVATARS[id] || DanielAvatar
  return <Avatar className={className} />
}
