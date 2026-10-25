// A host's three qualities as small calm chips (spans, so they fit inside a label).
import { cx } from './controls'

export function QualityChips({ qualities, className }) {
  return (
    <span className={cx('flex flex-wrap gap-2', className)}>
      {qualities.map((q) => (
        <span key={q} className="rounded-full border border-line bg-sage-tint px-3 py-0.5 text-sm font-bold text-ink">
          {q}
        </span>
      ))}
    </span>
  )
}
