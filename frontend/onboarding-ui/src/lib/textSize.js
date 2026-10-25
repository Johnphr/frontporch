// A / A+ / A++ text size: scales the root font size, so every rem-based size follows.
import { useEffect, useState } from 'react'

const KEY = 'fp-text-size'
export const TEXT_SIZES = [
  { id: 'a', label: 'A', aria: 'Normal text', scale: '100%' },
  { id: 'b', label: 'A+', aria: 'Larger text', scale: '115%' },
  { id: 'c', label: 'A++', aria: 'Largest text', scale: '130%' },
]

function load() {
  try {
    const saved = localStorage.getItem(KEY)
    return TEXT_SIZES.some((s) => s.id === saved) ? saved : 'a'
  } catch {
    return 'a'
  }
}

export function useTextSize() {
  const [size, setSize] = useState(load)
  useEffect(() => {
    document.documentElement.style.fontSize = TEXT_SIZES.find((s) => s.id === size).scale
    try {
      localStorage.setItem(KEY, size)
    } catch {
      /* storage unavailable: the choice lasts until reload */
    }
  }, [size])
  return [size, setSize]
}
