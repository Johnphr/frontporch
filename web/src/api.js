// Mock auth API: sign-in and the SMS code are fake for now (real auth comes later).
// Errors must be thrown with a `code` that exists in i18n `errors`.
// Demo triggers: password "error1234" -> BAD_PASSWORD, code "000000" -> BAD_CODE.
// The real backend calls (register, character, LinkedIn, call) live in backend.js.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fail = (code) => {
  const e = new Error(code)
  e.code = code
  throw e
}

export const authApi = {
  async signInWithGoogle() {
    await wait(600)
  },
  async signInWithEmail(email, password /* , mode */) {
    await wait(600)
    if (password === 'error1234') fail('BAD_PASSWORD')
  },
  async sendCode(/* e164 */) {
    await wait(600)
  },
  async verifyCode(/* e164 */ _phone, code) {
    await wait(600)
    if (code === '000000') fail('BAD_CODE')
  },
}
