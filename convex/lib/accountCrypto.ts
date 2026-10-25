// Encrypts his account secrets (Bluesky app password) for the elderAccounts table.
// AES-256-GCM with Web Crypto, key from env ACCOUNTS_ENC_KEY (base64 of 32 random bytes:
// `openssl rand -base64 32`). A fresh random IV per secret. The elderId + platform are bound
// in as additional data, so a ciphertext copied onto another elder's row won't decrypt.
// Decrypt only inside actions (lib/logins.ts). Errors never include the key or the secret.
// No runtime imports: unit-tested directly with Node (tests/accounts.test.ts).

export type Platform = "bluesky" | "reddit";
export type SealedSecret = { ciphertext: string; iv: string };

const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Missing or malformed ACCOUNTS_ENC_KEY. There is no plaintext fallback. */
export class AccountKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountKeyError";
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array | undefined {
  const clean = text.trim();
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return undefined;
  try {
    const s = atob(clean);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/** The additional data for one secret: ties it to this elder and platform. */
export function secretAad(elderId: string, platform: Platform): Uint8Array {
  return new TextEncoder().encode(`frontporch/elderAccounts/v1/${elderId}/${platform}`);
}

/** ACCOUNTS_ENC_KEY -> an AES-GCM key. Throws AccountKeyError if it's missing or not 32 bytes of base64. */
export async function loadAccountKey(raw: string | undefined): Promise<CryptoKey> {
  if (!raw || !raw.trim()) {
    throw new AccountKeyError("ACCOUNTS_ENC_KEY is not set (make one with: openssl rand -base64 32)");
  }
  const bytes = fromBase64(raw);
  if (!bytes || bytes.length !== KEY_BYTES) {
    throw new AccountKeyError("ACCOUNTS_ENC_KEY must be base64 of exactly 32 bytes (openssl rand -base64 32)");
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(key: CryptoKey, plaintext: string, elderId: string, platform: Platform): Promise<SealedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: secretAad(elderId, platform) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: toBase64(new Uint8Array(data)), iv: toBase64(iv) };
}

/** Throws (with a fixed message) on a wrong key, a moved or edited ciphertext, or bad base64. */
export async function decryptSecret(key: CryptoKey, sealed: SealedSecret, elderId: string, platform: Platform): Promise<string> {
  const iv = fromBase64(sealed.iv);
  const data = fromBase64(sealed.ciphertext);
  if (!iv || iv.length !== IV_BYTES || !data) throw new Error("Account secret is malformed");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: secretAad(elderId, platform) },
      key,
      data,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("Account secret could not be decrypted (wrong key, or not this elder's)");
  }
}
