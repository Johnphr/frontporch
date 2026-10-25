// Strangers' replies feed his next call (llm.summarizeFeedback: readerQuestions for the
// planner, `line` that Pip reads aloud, `resonated` for the writer). A reply can try to make
// Pip say a link, a number or "send money". The prompt says no; this enforces it in code
// after the LLM call. EN + ES. Pure: tests/readerSafety.test.ts.

// Whole words in any script (\b doesn't know accents).
const word = (alts: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts})(?![\\p{L}\\p{N}_])`, "iu");

// Career questions talk about money, prices, banks and calls all the time ("How did you price
// bread?", "When did you start at the bank?"), so plain words pass. Blocked: anything to click
// or dial, and the shapes scams take: payment apps, credentials, "send me / call me".
const RULES: RegExp[] = [
  // links: scheme, www., or a bare domain
  /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|me|ly|app|xyz|info|biz|link|site|online|shop|store|us|uk|mx|es|ar|gl|gg|to|tv|tk)\b/i,
  // emails
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  // @handles
  /(?:^|[^\w])@[A-Za-z0-9_][A-Za-z0-9_.-]*/,
  // EN payment apps, credentials, account details
  word(
    "paypal|venmo|zelle|cash ?app|western union|moneygram|bitcoin|btc|crypto|usdt|gift ?cards?|wire transfer|wire me|bank account|account numbers?|routing numbers?|card numbers?|credit card|debit card|password|passwords|passcode|pin code|verification code|one-time code|ssn|social security number|log ?in details|login details",
  ),
  // ES
  word(
    "bizum|mercado pago|western union|bitcoin|cripto|tarjeta de regalo|transferencia bancaria|cuenta bancaria|número de cuenta|numero de cuenta|clabe|tarjeta de crédito|tarjeta de credito|tarjeta de débito|tarjeta de debito|datos de (?:su|tu) tarjeta|contraseña|contrasena|código de verificación|codigo de verificacion|nip",
  ),
  // EN asks aimed at him: send / pay / contact me
  word(
    "send (?:me|us|him|her|them|it|money|cash|\\$)|pay (?:me|us)|(?:call|text|dm|message|email|e-mail|contact|ring|phone) (?:me|us|my)|reach (?:me|us|out to me)|your (?:email|e-mail|phone number|number|home address|address)|whatsapp|telegram|signal me",
  ),
  // ES
  word(
    "llámame|llamame|llámeme|llameme|llámenos|llamenos|escríbame|escribame|escríbeme|escribeme|envíeme|envieme|envíame|enviame|mándeme|mandeme|mándame|mandame|contácteme|contacteme|contáctame|contactame|depósitame|depositame|deposíteme|depositeme|págame|pagame|págueme|pagueme|mándame dinero|mándeme dinero|mandar dinero|enviar dinero|(?:su|tu) (?:correo|número|numero|teléfono|telefono|dirección|direccion)|whatsapp|telegram",
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

/** True when reader-derived text has a link, phone, email, @handle, a payment app or credential, or a send/pay/contact-me ask. */
export function unsafeReaderText(text: string): boolean {
  return hasPhone(text) || RULES.some((r) => r.test(text));
}

/** Most comments a call gets word for word, and how long each may be. */
export const MAX_QUOTED_COMMENTS = 5;
const MAX_QUOTE_CHARS = 300;

/**
 * Readers' exact words for his next call (the host reads one only if he asks for the exact
 * words). Rude ones stay (his choice to hear them); anything to click, dial or pay is dropped,
 * like the rest of reader text. Newest last; one comment per line.
 */
export function quotableComments(comments: { text: string }[], max = MAX_QUOTED_COMMENTS): string {
  return comments
    .map((c) => c.text.replace(/\s+/g, " ").trim())
    .filter((t) => t && t.length <= MAX_QUOTE_CHARS && !unsafeReaderText(t))
    .slice(-max)
    .map((t) => `- "${t}"`)
    .join("\n");
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
