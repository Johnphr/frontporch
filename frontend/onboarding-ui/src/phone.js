// Countries the sign-up form offers: dial code, national digit count, and display grouping.
export const COUNTRIES = [
  { code: 'US', dial: '+1', digits: 10, groups: [3, 3, 4], name: 'United States', example: '(555) 012-3456' },
  { code: 'MX', dial: '+52', digits: 10, groups: [2, 4, 4], name: 'Mexico', example: '55 1234 5678' },
  { code: 'ES', dial: '+34', digits: 9, groups: [3, 3, 3], name: 'Spain', example: '612 345 678' },
]

/** "+15550123456" -> the country and its formatted national number, for showing a saved phone. */
export function splitE164(e164) {
  const country = COUNTRIES.find((c) => (e164 || '').startsWith(c.dial) && digitsOf(e164).length === c.dial.length - 1 + c.digits)
  if (!country) return { country: COUNTRIES[0], national: e164 || '' }
  return { country, national: formatNational(country, digitsOf(e164).slice(country.dial.length - 1)) }
}

export const digitsOf = (value) => value.replace(/\D/g, '')

/** Format national digits for display while typing. */
export function formatNational(country, raw) {
  const d = digitsOf(raw).slice(0, country.digits)
  const groups = country.groups
  const out = []
  let i = 0
  for (const g of groups) {
    if (i >= d.length) break
    out.push(d.slice(i, i + g))
    i += g
  }
  if (country.code === 'US' && out.length) {
    const [a, b, c] = out
    return `(${a}${a.length === 3 ? ')' : ''}${b ? ' ' + b : ''}${c ? '-' + c : ''}`
  }
  return out.join(' ')
}

export const toE164 = (country, raw) => `${country.dial}${digitsOf(raw)}`
