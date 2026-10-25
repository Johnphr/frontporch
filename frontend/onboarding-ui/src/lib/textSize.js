// A / A+ / A++ text size: sets data-text-size on <html>; index.css maps it to a root font size,
// so every rem-based size follows. Desktop starts smaller (80%) for more air; A+ is full size.
import { useEffect, useState } from 'react'

const KEY = 'fp-text-size'
export const TEXT_SIZES = [
  { id: 'a', label: 'A', aria: 'Normal text' },
  { id: 'b', label: 'A+', aria: 'Larger text' },
  { id: 'c', label: 'A++', aria: 'Largest text' },
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
    document.documentElement.dataset.textSize = size
    try {
      localStorage.setItem(KEY, size)
    } catch {
      /* storage unavailable: the choice lasts until reload */
    }
  }, [size])
  return [size, setSize]
}
