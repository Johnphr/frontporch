// Host avatars (flat, no outlines): Pip is a round rose character with a sound-wave smile,
// Juanito a round sage one with a rose bow tie. Decorative: the host's name is always next to it.

export function PipAvatar({ className = 'h-24 w-24' }) {
  return (
    <svg viewBox="0 0 72 72" className={className} aria-hidden="true" focusable="false">
      <circle cx="36" cy="36" r="36" fill="#F7D6DE" />
      <circle cx="36" cy="39" r="24" fill="#A8475E" />
      <circle cx="28" cy="34" r="3.2" fill="#FFFFFF" />
      <circle cx="44" cy="34" r="3.2" fill="#FFFFFF" />
      <path d="M24 46 q3 -4 6 0 t6 0 t6 0 t6 0" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}

export function JuanitoAvatar({ className = 'h-24 w-24' }) {
  return (
    <svg viewBox="0 0 72 72" className={className} aria-hidden="true" focusable="false">
      <circle cx="36" cy="36" r="36" fill="#E6EEE9" />
      <circle cx="36" cy="34" r="22" fill="#8FAE9B" />
      <circle cx="29" cy="31" r="2.8" fill="#3A2A2E" />
      <circle cx="43" cy="31" r="2.8" fill="#3A2A2E" />
      <path d="M29 40 Q36 46 43 40" fill="none" stroke="#3A2A2E" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M24 58 L34 53.5 L34 62.5 Z M48 58 L38 53.5 L38 62.5 Z" fill="#A8475E" />
      <circle cx="36" cy="58" r="3.4" fill="#A8475E" />
    </svg>
  )
}

export function HostAvatar({ id, className }) {
  return id === 'juanito' ? <JuanitoAvatar className={className} /> : <PipAvatar className={className} />
}
