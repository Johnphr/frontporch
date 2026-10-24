import { Button, ErrorBanner, GoogleIcon, PasswordField, ScreenHeader, TextField } from '../ui'

// Screen 1: sign in or register (fake for now, see api.js).
export default function SignIn({ t, headingRef, busy, error, fieldErrors, form, onGoogle, onAccount, onToggleMode }) {
  const { mode, email, setEmail, password, setPassword } = form
  return (
    <>
      <ScreenHeader
        headingRef={headingRef}
        title={mode === 'signin' ? t.s1.titleIn : t.s1.titleReg}
        lead={mode === 'signin' ? t.s1.leadIn : t.s1.leadReg}
      />

      <Button variant="secondary" icon={<GoogleIcon />} onClick={onGoogle} disabled={busy}>
        {t.s1.google}
      </Button>

      <div className="flex items-center gap-4 text-lg text-tinta-700" role="separator">
        <span aria-hidden="true" className="h-0.5 flex-1 bg-lino-300" />
        <span>{t.s1.or}</span>
        <span aria-hidden="true" className="h-0.5 flex-1 bg-lino-300" />
      </div>

      <form noValidate onSubmit={onAccount} className="flex flex-col gap-5">
        <TextField
          id="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          label={t.s1.email}
          hint={t.s1.emailHint}
          error={fieldErrors.email}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordField
          id="password"
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          label={t.s1.password}
          hint={mode === 'register' ? t.s1.passwordHint : undefined}
          error={fieldErrors.password}
          labels={t.s1}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorBanner>{error}</ErrorBanner>
        <Button type="submit" disabled={busy}>
          {busy ? t.working : mode === 'signin' ? t.s1.submitIn : t.s1.submitReg}
        </Button>
      </form>

      <Button variant="quiet" onClick={onToggleMode}>
        {mode === 'signin' ? t.s1.toReg : t.s1.toIn}
      </Button>
    </>
  )
}
