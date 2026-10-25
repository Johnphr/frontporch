// Landing illustrations, part 1 (hero, the three steps, the promise, the promise tick).
// Portraits in the host style (see people.jsx). All decorative except the hero, which gets a label.
import { HostAvatar } from './hosts'
import { HelperAvatar, MARGARET_HAND, MargaretAvatar, WalterAvatar } from './people'
import { CheckBadge, CallBadge, Deco, Heart, PhoneInHand, Seat, Waves } from './scene'

const LINE = '#E5E1E2'
const card = { fill: '#FFFFFF', stroke: LINE, strokeWidth: 2 }

/** Margaret on the phone, smiling; her host Daniel is on the line (small, lower right). */
export function HeroArt({ label }) {
  return (
    <svg viewBox="0 0 480 480" className="block h-auto w-full" role="img" aria-label={label}>
      <Seat x={20} y={16} size={400}>
        <MargaretAvatar className="">
          <PhoneInHand {...MARGARET_HAND} />
        </MargaretAvatar>
      </Seat>
      <Waves x={372} y={160} r={18} width={6} />
      <Seat x={308} y={308} size={150} halo={8}>
        <HostAvatar id="daniel" className="" />
      </Seat>
    </svg>
  )
}

/** Step 1: the helper beside a sign-up form, one field already ticked. */
export function SignUpArt() {
  return (
    <Deco viewBox="0 0 320 240">
      <Seat x={16} y={40} size={164}>
        <HelperAvatar className="" />
      </Seat>
      <rect x="150" y="58" width="152" height="124" rx="18" {...card} />
      <rect x="170" y="80" width="92" height="16" rx="8" fill="#F3F0F1" />
      <CheckBadge x={283} y={88} r={9} fill="#7E9E8B" />
      <rect x="170" y="112" width="112" height="16" rx="8" fill="#F3F0F1" />
      <rect x="170" y="144" width="80" height="16" rx="8" fill="#F3F0F1" />
      <rect x="254" y="146" width="3" height="12" rx="1.5" fill="#A8475E" />
    </Deco>
  )
}

/** Step 2: the four hosts in a gentle arc under a ringing call badge. */
export function CallArt() {
  return (
    <Deco viewBox="0 0 320 240">
      <CallBadge x={160} y={50} r={22} />
      <Waves x={190} y={50} r={10} width={3.5} />
      <Waves x={130} y={50} r={10} width={3.5} dir={-1} />
      <Seat x={14} y={120} size={96} halo={5}>
        <HostAvatar id="oscar" className="" />
      </Seat>
      <Seat x={210} y={120} size={96} halo={5}>
        <HostAvatar id="diana" className="" />
      </Seat>
      <Seat x={146} y={98} size={96} halo={5}>
        <HostAvatar id="victoria" className="" />
      </Seat>
      <Seat x={78} y={98} size={96} halo={5}>
        <HostAvatar id="daniel" className="" />
      </Seat>
    </Deco>
  )
}

/** Step 3: a LinkedIn-style post by Margaret, with a like and a comment. */
export function PostArt() {
  return (
    <Deco viewBox="0 0 320 240">
      <circle cx="160" cy="120" r="112" fill="#FCE4E8" />
      <rect x="44" y="34" width="232" height="172" rx="18" {...card} />
      <Seat x={62} y={52} size={44}>
        <MargaretAvatar className="" />
      </Seat>
      <rect x="116" y="60" width="84" height="9" rx="4.5" fill="#3A2A2E" opacity="0.75" />
      <rect x="116" y="76" width="54" height="7" rx="3.5" fill="#D6D0CE" />
      <g fill={LINE}>
        <rect x="62" y="112" width="196" height="8" rx="4" />
        <rect x="62" y="128" width="182" height="8" rx="4" />
        <rect x="62" y="144" width="192" height="8" rx="4" />
        <rect x="62" y="160" width="118" height="8" rx="4" />
      </g>
      <Heart x={70} y={185} r={8} />
      <rect x="88" y="177" width="20" height="15" rx="6" fill="#7E9E8B" />
      <path d="M92 190 L90 197 L98 191 Z" fill="#7E9E8B" />
    </Deco>
  )
}

/** The promise: Walter with a sage check badge and a quote bubble in his words. */
export function PromiseArt() {
  return (
    <Deco viewBox="0 0 360 260">
      <path d="M232 98 L210 128 L252 104 Z" fill="#E5EEE9" />
      <rect x="222" y="30" width="122" height="80" rx="24" fill="#E5EEE9" />
      <g fill="#A8475E">
        <circle cx="245" cy="58" r="5.5" />
        <circle cx="260" cy="58" r="5.5" />
      </g>
      <path d="M240 57 Q240 48 248 45 M255 57 Q255 48 263 45" fill="none" stroke="#A8475E" strokeWidth="4" strokeLinecap="round" />
      <g fill="#9DB8A8">
        <rect x="272" y="50" width="54" height="8" rx="4" />
        <rect x="240" y="72" width="86" height="8" rx="4" />
        <rect x="240" y="88" width="58" height="8" rx="4" />
      </g>
      <Seat x={28} y={36} size={200}>
        <WalterAvatar className="" />
      </Seat>
      <CheckBadge x={200} y={206} r={24} />
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
