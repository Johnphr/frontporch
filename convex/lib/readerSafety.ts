// Strangers' replies feed his next call (llm.summarizeFeedback: readerQuestions for the
// planner, `line` that Pip reads aloud, `resonated` for the writer). A reply can try to make
// Pip say a link, a number or "send money". The prompt says no; this enforces it in code
// after the LLM call. EN + ES. Pure: tests/readerSafety.test.ts.

// Whole words in any script (\b doesn't know accents).
const word = (alts: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts})(?![\\p{L}\\p{N}_])`, "iu");

const RULES: RegExp[] = [
  // links: scheme, www., or a bare domain
  /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|me|ly|app|xyz|info|biz|link|site|online|shop|store|us|uk|mx|es|ar|gl|gg|to|tv|tk)\b/i,
  // emails
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  // @handles
  /(?:^|[^\w])@[A-Za-z0-9_][A-Za-z0-9_.-]*/,
  // money symbols, amounts
  /[$€£¥₿]|\b\d[\d.,]*\s?(?:k|usd|eur|mxn|btc)\b/i,
  // EN money, payments, accounts, passwords
  word(
    "money|cash|dollars?|bucks|euros?|pay|pays|paying|paid|payment|payments|paypal|venmo|zelle|cash ?app|bitcoin|crypto|wire|gift ?cards?|bank|banks|banking|account numbers?|routing|password|passwords|passcode|pin|login|log in|sign in|verify|verification code|credit card|debit card|card number|ssn|social security|invest|investment|donate|donation|fee|fees",
  ),
  // ES dinero, pagos, cuentas, contraseñas
  word(
    "dinero|efectivo|pesos|dólares?|dolares?|pago|pagos|pagar|paga|págame|pagame|transferencia|transferir|depósito|deposito|depositar|banco|bancos|bancaria|bancario|cuenta bancaria|número de cuenta|numero de cuenta|tu cuenta|contraseña|contrasena|tarjeta|bizum|mercado pago|invertir|inversión|inversion|donar|donación|donacion|comisión|comision",
  ),
  // EN instructions to contact anyone
  word("call|calls|calling|text|texts|texting|send|sends|sending|dm|dms|message me|email|e-mail|whatsapp|telegram|contact|reach out|ring me"),
  // ES
  word(
    "llama|llamar|llámame|llamame|llámeme|llameme|llámale|llamale|escríbame|escribame|envíeme|envieme|mándeme|mandeme|contácteme|contacteme|escribe|escribir|escríbeme|escribeme|envía|envia|enviar|envíame|enviame|manda|mandar|mándame|mandame|mensaje|contacta|contactar|contáctame|contactame|correo|whatsapp|telegram",
  ),
];

/** A phone number: 7+ digits with only spaces, dots, dashes, parens between (not a year range). */
function hasPhone(text: string): boolean {
  for (const m of text.matchAll(/\+?\(?\d[\d\s().\-–]{5,}\d/g)) {
    const s = m[0].trim();
    if (/^\d{4}\s*[-–]\s*\d{2,4}$/.test(s)) continue; // 1950-1960
    if ((s.match(/\d/g) ?? []).length >= 7) return true;
  }
  return false;
}

/** True when reader-derived text has a link, phone, email, @handle, money / account / password word, or a contact instruction. */
export function unsafeReaderText(text: string): boolean {
  return hasPhone(text) || RULES.some((r) => r.test(text));
}

export type Feedback = { resonated: string; readerQuestions: string[]; line: string };

/** Drop unsafe reader questions; blank an unsafe line or resonated. */
export function safeFeedback(f: Feedback): Feedback {
  return {
    resonated: unsafeReaderText(f.resonated) ? "" : f.resonated,
    readerQuestions: f.readerQuestions.filter((q) => !unsafeReaderText(q)),
    line: unsafeReaderText(f.line) ? "" : f.line,
  };
}
