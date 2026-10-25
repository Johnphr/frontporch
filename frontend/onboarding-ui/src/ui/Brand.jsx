// The name, MEMORIA, with "IA" in bold (memoria + IA). `branded(text)` does the same for the
// name inside a sentence; other text passes through unchanged.
export function Brand() {
  // One span so a flex parent (the logo link) keeps the word in one piece.
  return (
    <span>
      MEMOR<strong className="font-bold">IA</strong>
    </span>
  )
}

export function branded(text) {
  if (typeof text !== 'string' || !text.includes('MEMORIA')) return text
  return text.split('MEMORIA').flatMap((part, i) => (i ? [<Brand key={i} />, part] : [part]))
}
