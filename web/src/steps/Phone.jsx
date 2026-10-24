import { COUNTRIES } from '../i18n'
import { digitsOf, formatNational } from '../phone'
import { Button, ErrorBanner, Note, ScreenHeader, SelectField, TextField } from '../ui'

// Screen 2: name + phone number, then the 6-digit code (the code is fake for now).
export default function Phone({ t, lang, headingRef, busy, error, fieldErrors, form, actions }) {
  const { stage, name, setName, country, countryCode, phone, setPhone, code, setCode, cooldown, resendsLeft } = form
  const { onCountry, onPhone, onVerify, onResend, onChangeNumber } = actions

  if (stage === 'number') {
    return (
      <>
        <ScreenHeader headingRef={headingRef} title={t.s2.title} lead={t.s2.lead} />
        <form noValidate onSubmit={onPhone} className="flex flex-1 flex-col gap-5">
          <TextField
            id="name"
            autoComplete="name"
            maxLength={80}
            label={t.s2.name}
            hint={t.s2.nameHint}
            error={fieldErrors.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <SelectField id="country" label={t.s2.country} value={countryCode} onChange={(e) => onCountry(e.target.value)}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.names[lang]} ({c.dial})
              </option>
            ))}
          </SelectField>
          <TextField
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            label={t.s2.phone}
            error={fieldErrors.phone}
            placeholder={formatNational(country, '5512345678')}
            value={phone}
            onChange={(e) => setPhone(formatNational(country, e.target.value))}
          />
          <Note>{t.s2.privacy}</Note>
          <ErrorBanner>{error}</ErrorBanner>
          <div className="flex-1" />
          <Button type="submit" disabled={busy}>
            {busy ? t.working : t.s2.continue}
          </Button>
        </form>
      </>
    )
  }

  return (
    <>
      <ScreenHeader headingRef={headingRef} title={t.s2.codeTitle} lead={t.s2.codeLead(`${country.dial} ${phone}`)} />
      <form noValidate onSubmit={onVerify} className="flex flex-1 flex-col gap-5">
        <TextField
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          label={t.s2.code}
          error={fieldErrors.code}
          placeholder="000 000"
          className="text-center text-3xl tracking-[0.3em]"
          value={code}
          onChange={(e) => setCode(digitsOf(e.target.value).slice(0, 6))}
        />
        <ErrorBanner>{error}</ErrorBanner>
        <Button type="submit" disabled={busy}>
          {busy ? t.working : t.s2.verify}
        </Button>
        <div className="flex flex-col gap-3" aria-live="polite">
          <Button variant="secondary" onClick={onResend} disabled={busy || cooldown > 0 || resendsLeft <= 0}>
            {t.s2.resend}
          </Button>
          <p className="text-lg text-tinta-700">
            {resendsLeft <= 0
              ? t.s2.noResends
              : `${cooldown > 0 ? t.s2.resendIn(cooldown) + ' ' : ''}${t.s2.resendsLeft(resendsLeft)}`}
          </p>
        </div>
        <Button variant="quiet" onClick={onChangeNumber} disabled={busy}>
          {t.s2.changeNumber}
        </Button>
      </form>
    </>
  )
}
