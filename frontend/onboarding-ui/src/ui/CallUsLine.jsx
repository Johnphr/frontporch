// "Want to talk sooner? Call Oscar any time at (415) 555-0123." The inbound number comes from
// VITE_PORCH_NUMBER (E.164, build time); without it the line is hidden.
import { splitE164 } from '../phone'

const NUMBER = (import.meta.env.VITE_PORCH_NUMBER || '').trim()
const VALID = /^\+[1-9]\d{6,14}$/.test(NUMBER)

function display(e164) {
  const { country, national } = splitE164(e164)
  return country.dial === '+1' ? national : `${country.dial} ${national}`
}

export function CallUsLine({ host, className = '' }) {
  if (!VALID) return null
  return (
    <p className={`max-w-[40rem] text-lg ${className}`}>
      Want to talk sooner? Call {host} any time at{' '}
      <a href={`tel:${NUMBER}`} className="select-all whitespace-nowrap font-bold">
        {display(NUMBER)}
      </a>
      .
    </p>
  )
}
