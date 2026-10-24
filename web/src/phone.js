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
