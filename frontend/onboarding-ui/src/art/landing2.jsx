// Landing illustrations, part 2 (family, final call to action, the small avatar on quotes).
// Portraits in the host style (see people.jsx). All decorative: the text next to each says the same.
import { HelperAvatar, MargaretAvatar, WALTER_HAND, WalterAvatar } from './people'
import { Deco, Heart, PhoneInHand, Seat, Waves } from './scene'

/** A daughter and her father side by side, a small heart between them. */
export function FamilyArt() {
  return (
    <Deco viewBox="0 0 360 240">
      <Seat x={22} y={44} size={180}>
        <HelperAvatar className="" />
      </Seat>
      <Seat x={158} y={44} size={180} halo={6}>
        <WalterAvatar className="" />
      </Seat>
      <Heart x={180} y={30} r={13} />
    </Deco>
  )
}

/** Final call to action: Walter takes the call, Margaret leans in beside him. */
export function PorchArt() {
  return (
    <Deco viewBox="0 0 340 260">
      <Seat x={182} y={60} size={150}>
        <MargaretAvatar className="" />
      </Seat>
      <Seat x={40} y={30} size={210} halo={6}>
        <WalterAvatar className="">
          <PhoneInHand {...WALTER_HAND} flip />
        </WalterAvatar>
      </Seat>
      <Waves x={62} y={100} r={14} width={5} dir={-1} />
    </Deco>
  )
}

/** Small round portrait for the example post and quotes (only Margaret for now). */
export function Avatar({ who }) {
  if (who !== 'margaret') return null
  return <MargaretAvatar className="block h-16 w-16 flex-none overflow-hidden rounded-full" />
}
