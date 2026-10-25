// Landing illustrations, part 2 (questions, readers, family, why, final porch, small avatars).
// All decorative: the text next to each one says the same thing.
import { Deco } from './landing'

/** Two speech bubbles and a "typing" bubble. */
export function QuestionsArt() {
  return (
    <Deco viewBox="0 0 320 240">
      <circle cx="160" cy="120" r="108" fill="#FFFFFF" />
      <rect x="40" y="40" width="150" height="56" rx="28" fill="#F2B8C6" />
      <path d="M70 90 L60 112 L90 94 Z" fill="#F2B8C6" />
      <rect x="66" y="58" width="90" height="8" rx="4" fill="#FFFFFF" />
      <rect x="66" y="72" width="60" height="8" rx="4" fill="#FFFFFF" opacity="0.75" />
      <rect x="130" y="112" width="150" height="56" rx="28" fill="#8FAE9B" />
      <path d="M250 162 L262 184 L232 168 Z" fill="#8FAE9B" />
      <rect x="156" y="130" width="96" height="8" rx="4" fill="#FFFFFF" />
      <rect x="156" y="144" width="70" height="8" rx="4" fill="#FFFFFF" opacity="0.75" />
      <rect x="60" y="178" width="90" height="40" rx="20" fill="#F7D6DE" />
      <circle cx="88" cy="198" r="5" fill="#5B474C" />
      <circle cx="105" cy="198" r="5" fill="#5B474C" />
      <circle cx="122" cy="198" r="5" fill="#5B474C" />
    </Deco>
  )
}

/** A baker holding a tray of bread, with comment bubbles. */
export function ReadersArt() {
  return (
    <Deco viewBox="0 0 320 260">
      <circle cx="160" cy="125" r="112" fill="#FCEEF1" />
      <ellipse cx="150" cy="240" rx="64" ry="8" fill="#3A2A2E" opacity="0.1" />
      <rect x="128" y="160" width="20" height="78" rx="10" fill="#5B474C" />
      <rect x="152" y="160" width="20" height="78" rx="10" fill="#5B474C" />
      <ellipse cx="136" cy="238" rx="15" ry="7" fill="#3A2A2E" />
      <ellipse cx="166" cy="238" rx="15" ry="7" fill="#3A2A2E" />
      <rect x="114" y="92" width="72" height="88" rx="30" fill="#8FAE9B" />
      <path d="M126 112 H174 V176 A8 8 0 0 1 166 184 H134 A8 8 0 0 1 126 176 Z" fill="#FFFFFF" />
      <rect x="102" y="98" width="20" height="56" rx="10" fill="#8FAE9B" />
      <rect x="178" y="98" width="20" height="56" rx="10" fill="#8FAE9B" />
      <ellipse cx="150" cy="146" rx="42" ry="17" fill="#D9A07E" />
      <ellipse cx="134" cy="142" rx="6" ry="3" fill="#F3CBB0" transform="rotate(-30 134 142)" />
      <ellipse cx="150" cy="140" rx="6" ry="3" fill="#F3CBB0" transform="rotate(-30 150 140)" />
      <ellipse cx="166" cy="142" rx="6" ry="3" fill="#F3CBB0" transform="rotate(-30 166 142)" />
      <circle cx="112" cy="150" r="10" fill="#A9714F" />
      <circle cx="188" cy="150" r="10" fill="#A9714F" />
      <rect x="142" y="78" width="16" height="20" rx="6" fill="#A9714F" />
      <circle cx="150" cy="64" r="26" fill="#C9C3C5" />
      <circle cx="150" cy="68" r="24" fill="#A9714F" />
      <rect x="128" y="34" width="44" height="22" rx="10" fill="#FFFFFF" />
      <ellipse cx="150" cy="34" rx="20" ry="12" fill="#FFFFFF" />
      <circle cx="142" cy="70" r="2.5" fill="#3A2A2E" />
      <circle cx="158" cy="70" r="2.5" fill="#3A2A2E" />
      <rect x="204" y="36" width="92" height="42" rx="14" fill="#F2B8C6" />
      <path d="M214 74 L208 90 L228 76 Z" fill="#F2B8C6" />
      <circle cx="222" cy="57" r="8" fill="#FFFFFF" />
      <rect x="236" y="50" width="48" height="6" rx="3" fill="#FFFFFF" />
      <rect x="236" y="60" width="32" height="6" rx="3" fill="#FFFFFF" opacity="0.75" />
      <rect x="214" y="96" width="80" height="38" rx="14" fill="#CFDDD4" />
      <circle cx="231" cy="115" r="7" fill="#FFFFFF" />
      <rect x="244" y="109" width="40" height="6" rx="3" fill="#FFFFFF" />
      <rect x="244" y="119" width="26" height="6" rx="3" fill="#FFFFFF" opacity="0.75" />
    </Deco>
  )
}

/** A parent and an adult child setting things up on a tablet. */
export function FamilyArt() {
  return (
    <Deco viewBox="0 0 340 260">
      <circle cx="170" cy="125" r="114" fill="#F7D6DE" />
      <ellipse cx="170" cy="240" rx="110" ry="8" fill="#3A2A2E" opacity="0.1" />
      <rect x="100" y="160" width="18" height="78" rx="9" fill="#5B474C" />
      <rect x="122" y="160" width="18" height="78" rx="9" fill="#5B474C" />
      <ellipse cx="107" cy="238" rx="14" ry="6" fill="#3A2A2E" />
      <ellipse cx="135" cy="238" rx="14" ry="6" fill="#3A2A2E" />
      <rect x="88" y="92" width="64" height="86" rx="28" fill="#A8475E" />
      <rect x="78" y="100" width="18" height="64" rx="9" fill="#A8475E" />
      <circle cx="87" cy="166" r="9" fill="#F3CBB0" />
      <rect x="144" y="100" width="18" height="64" rx="9" fill="#A8475E" transform="rotate(-14 153 109)" />
      <circle cx="166" cy="162" r="9" fill="#F3CBB0" />
      <rect x="112" y="78" width="16" height="20" rx="6" fill="#F3CBB0" />
      <circle cx="120" cy="38" r="11" fill="#EDE9EA" />
      <circle cx="120" cy="62" r="26" fill="#EDE9EA" />
      <circle cx="120" cy="68" r="23" fill="#F3CBB0" />
      <path d="M97 66 A23 23 0 0 1 143 66 Q124 52 97 66 Z" fill="#EDE9EA" />
      <circle cx="112" cy="70" r="2.5" fill="#3A2A2E" />
      <circle cx="128" cy="70" r="2.5" fill="#3A2A2E" />
      <rect x="200" y="156" width="18" height="82" rx="9" fill="#3A2A2E" />
      <rect x="224" y="156" width="18" height="82" rx="9" fill="#3A2A2E" />
      <ellipse cx="207" cy="238" rx="14" ry="6" fill="#5B474C" />
      <ellipse cx="235" cy="238" rx="14" ry="6" fill="#5B474C" />
      <rect x="188" y="86" width="64" height="88" rx="28" fill="#6F9180" />
      <rect x="187" y="96" width="18" height="64" rx="9" fill="#6F9180" transform="rotate(14 196 105)" />
      <circle cx="183" cy="158" r="9" fill="#7A4E3A" />
      <rect x="226" y="112" width="40" height="54" rx="5" fill="#5B474C" />
      <rect x="231" y="118" width="30" height="40" rx="3" fill="#F2B8C6" />
      <rect x="242" y="100" width="18" height="58" rx="9" fill="#6F9180" />
      <circle cx="250" cy="158" r="9" fill="#7A4E3A" />
      <rect x="212" y="72" width="16" height="20" rx="6" fill="#7A4E3A" />
      <circle cx="220" cy="56" r="26" fill="#3A2A2E" />
      <circle cx="220" cy="62" r="23" fill="#7A4E3A" />
      <path d="M197 60 A23 23 0 0 1 243 60 Q220 50 197 60 Z" fill="#3A2A2E" />
      <circle cx="212" cy="64" r="2.5" fill="#241A1C" />
      <circle cx="228" cy="64" r="2.5" fill="#241A1C" />
    </Deco>
  )
}

/** Three people at a hackathon table with a laptop. */
export function WhyArt() {
  return (
    <Deco viewBox="0 0 340 240">
      <circle cx="170" cy="120" r="110" fill="#E6EEE9" />
      <rect x="70" y="118" width="60" height="64" rx="28" fill="#F2B8C6" />
      <circle cx="86" cy="92" r="9" fill="#3A2A2E" />
      <circle cx="100" cy="92" r="22" fill="#3A2A2E" />
      <circle cx="100" cy="96" r="20" fill="#F3CBB0" />
      <circle cx="93" cy="98" r="2.2" fill="#3A2A2E" />
      <circle cx="107" cy="98" r="2.2" fill="#3A2A2E" />
      <rect x="138" y="104" width="64" height="78" rx="30" fill="#A8475E" />
      <circle cx="156" cy="66" r="11" fill="#3A2A2E" />
      <circle cx="170" cy="62" r="12" fill="#3A2A2E" />
      <circle cx="184" cy="66" r="11" fill="#3A2A2E" />
      <circle cx="170" cy="82" r="21" fill="#A9714F" />
      <circle cx="163" cy="84" r="2.2" fill="#3A2A2E" />
      <circle cx="177" cy="84" r="2.2" fill="#3A2A2E" />
      <rect x="210" y="120" width="60" height="62" rx="28" fill="#6F9180" />
      <circle cx="240" cy="96" r="22" fill="#3A2A2E" />
      <circle cx="240" cy="101" r="20" fill="#7A4E3A" />
      <path d="M220 99 A20 20 0 0 1 260 99 Q240 88 220 99 Z" fill="#3A2A2E" />
      <circle cx="233" cy="103" r="2.2" fill="#241A1C" />
      <circle cx="247" cy="103" r="2.2" fill="#241A1C" />
      <rect x="140" y="136" width="60" height="42" rx="5" fill="#5B474C" />
      <circle cx="170" cy="157" r="4" fill="#F2B8C6" />
      <rect x="30" y="176" width="280" height="14" rx="7" fill="#D88A9C" />
      <rect x="50" y="190" width="8" height="34" rx="3" fill="#5B474C" />
      <rect x="282" y="190" width="8" height="34" rx="3" fill="#5B474C" />
      <rect x="132" y="172" width="76" height="6" rx="3" fill="#3A2A2E" />
      <rect x="56" y="156" width="18" height="18" rx="2" fill="#F2B8C6" transform="rotate(-8 65 165)" />
      <rect x="262" y="154" width="18" height="22" rx="4" fill="#FFFFFF" />
    </Deco>
  )
}

/** Final call to action: a house with a front porch, a chair and a plant. */
export function PorchArt() {
  return (
    <Deco viewBox="0 0 360 260">
      <ellipse cx="180" cy="238" rx="160" ry="10" fill="#3A2A2E" opacity="0.08" />
      <rect x="60" y="90" width="240" height="140" fill="#FFFFFF" />
      <path d="M40 98 L180 24 L320 98 Z" fill="#A8475E" />
      <rect x="50" y="120" width="260" height="14" rx="4" fill="#D88A9C" />
      <rect x="66" y="134" width="10" height="92" fill="#FCEEF1" />
      <rect x="284" y="134" width="10" height="92" fill="#FCEEF1" />
      <rect x="96" y="150" width="44" height="36" rx="4" fill="#F2B8C6" />
      <rect x="220" y="150" width="44" height="36" rx="4" fill="#F2B8C6" />
      <rect x="160" y="142" width="40" height="84" rx="4" fill="#8FAE9B" />
      <circle cx="192" cy="186" r="3" fill="#FCEEF1" />
      <circle cx="180" cy="62" r="12" fill="#F2B8C6" />
      <rect x="56" y="222" width="248" height="8" rx="3" fill="#6F9180" />
      <rect x="140" y="230" width="80" height="8" rx="2" fill="#F7D6DE" />
      <rect x="100" y="198" width="34" height="8" rx="4" fill="#5B474C" />
      <rect x="100" y="172" width="8" height="34" rx="4" fill="#5B474C" />
      <rect x="104" y="206" width="6" height="16" fill="#5B474C" />
      <rect x="126" y="206" width="6" height="16" fill="#5B474C" />
      <ellipse cx="256" cy="186" rx="10" ry="22" fill="#8FAE9B" transform="rotate(-20 256 206)" />
      <ellipse cx="270" cy="186" rx="10" ry="22" fill="#6F9180" transform="rotate(18 270 206)" />
      <path d="M248 202 H278 L274 222 H252 Z" fill="#D88A9C" />
    </Deco>
  )
}

// Round head-and-shoulders avatars for the example post and quotes.
const AVATARS = {
  margaret: { bg: '#F7D6DE', shirt: '#A8475E', hair: '#C9C3C5', skin: '#A9714F', eyes: '#3A2A2E' },
  nurse: { bg: '#F7D6DE', shirt: '#8FAE9B', hair: '#EDE9EA', skin: '#7A4E3A', eyes: '#241A1C' },
  shopOwner: { bg: '#E6EEE9', shirt: '#A8475E', hair: '#9A9194', skin: '#F3CBB0', eyes: '#3A2A2E' },
}

export function Avatar({ who }) {
  const a = AVATARS[who]
  return (
    <Deco viewBox="0 0 72 72" className="block h-16 w-16 flex-none overflow-hidden rounded-full">
      <rect width="72" height="72" fill={a.bg} />
      <path d="M12 72 A24 22 0 0 1 60 72 Z" fill={a.shirt} />
      <circle cx="36" cy="27" r="16" fill={a.hair} />
      <circle cx="36" cy="31" r="13" fill={a.skin} />
      <circle cx="31" cy="31" r="1.6" fill={a.eyes} />
      <circle cx="41" cy="31" r="1.6" fill={a.eyes} />
    </Deco>
  )
}
