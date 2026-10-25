// Read-only LinkedIn connection check (linkedapiCheck.ts): pure helpers for LinkedAPI's
// `POST /admin/accounts.getAll` response. Unit-tested in tests/linkedapiAccounts.test.ts.
//
// Response (docs: linkedapi.io/docs/admin-accounts):
//   { success, result: { accounts: [{ id, name, url, avatarUrl, headline, countryCode,
//       identificationToken, status: active | frozen | reconnection_required, connectedAt,
//       reconnectionSessionId?, reconnectionLink? }], pendingConnectionSessions: [{ sessionId, status }] } }
// The error shape isn't documented; we accept `success: false` with an optional error.type/message.
//
// Never return, log or echo an identificationToken: they're compared in memory only.

import { canonicalLinkedInProfileUrl } from "./signupRules.ts";

export const ACCOUNTS_GET_ALL_URL = "https://api.linkedapi.io/admin/accounts.getAll";

export type AccountStatus = "active" | "frozen" | "reconnection_required" | "unknown";

/** One connected LinkedIn account, safe to show (no identification token). */
export type SafeAccount = {
  id: string;
  name: string;
  profileUrl?: string; // canonical https://www.linkedin.com/in/<id>
  status: AccountStatus;
  connectedAt?: string;
  reconnectionLink?: string; // only when status is reconnection_required
};

export type ParsedAccounts =
  | { ok: true; accounts: SafeAccount[]; pendingSessions: number; tokens: Map<string, string> }
  | { ok: false; reason: string };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStatus(value: unknown): AccountStatus {
  return value === "active" || value === "frozen" || value === "reconnection_required" ? value : "unknown";
}

/**
 * accounts.getAll body -> accounts without tokens + a private id->token map (for in-memory
 * matching only; never put it in a result). `httpStatus` lets 401/403 read as a bad token.
 */
export function parseAccountsResponse(httpStatus: number, body: unknown): ParsedAccounts {
  if (httpStatus === 401 || httpStatus === 403) {
    return { ok: false, reason: `LinkedAPI rejected LINKEDAPI_TOKEN (HTTP ${httpStatus})` };
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (httpStatus < 200 || httpStatus >= 300 || b.success === false) {
    const err = (b.error ?? {}) as Record<string, unknown>;
    const type = str(err.type);
    return {
      ok: false,
      reason: `LinkedAPI accounts.getAll failed (HTTP ${httpStatus}${type ? `, ${type}` : ""})`,
    };
  }
  const result = (b.result ?? {}) as Record<string, unknown>;
  const rawAccounts = Array.isArray(result.accounts) ? result.accounts : [];
  const tokens = new Map<string, string>();
  const accounts: SafeAccount[] = [];
  for (const raw of rawAccounts) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const id = str(a.id);
    if (!id) continue;
    const status = asStatus(a.status);
    const urlRaw = str(a.url);
    const profileUrl = urlRaw ? canonicalLinkedInProfileUrl(urlRaw) : undefined;
    const connectedAt = str(a.connectedAt);
    const reconnectionLink = status === "reconnection_required" ? str(a.reconnectionLink) : undefined;
    accounts.push({
      id,
      name: str(a.name) ?? "(no name)",
      ...(profileUrl ? { profileUrl } : {}),
      status,
      ...(connectedAt ? { connectedAt } : {}),
      ...(reconnectionLink ? { reconnectionLink } : {}),
    });
    const token = str(a.identificationToken);
    if (token) tokens.set(id, token);
  }
  const pendingSessions = Array.isArray(result.pendingConnectionSessions) ? result.pendingConnectionSessions.length : 0;
  return { ok: true, accounts, pendingSessions, tokens };
}

/** Which account (if any) LINKEDAPI_ID_TOKEN belongs to. Compared in memory, never echoed. */
export function matchIdToken(
  accounts: SafeAccount[],
  tokens: Map<string, string>,
  idToken: string | undefined,
): SafeAccount | undefined {
  if (!idToken) return undefined;
  const id = [...tokens.entries()].find(([, token]) => token === idToken)?.[0];
  return id ? accounts.find((a) => a.id === id) : undefined;
}

/** The connected account whose LinkedIn profile is the elder's linkedinUrl. */
export function matchElderAccount(accounts: SafeAccount[], elderLinkedinUrl: string | undefined): SafeAccount | undefined {
  const wanted = elderLinkedinUrl ? canonicalLinkedInProfileUrl(elderLinkedinUrl) : undefined;
  if (!wanted) return undefined;
  return accounts.find((a) => a.profileUrl?.toLowerCase() === wanted.toLowerCase());
}

/** One line for a person: can we post as him right now? */
export function elderVerdict(elderLinkedinUrl: string | undefined, account: SafeAccount | undefined): string {
  if (!elderLinkedinUrl || !canonicalLinkedInProfileUrl(elderLinkedinUrl)) return "his row has no linkedinUrl";
  if (!account) return "not connected to LinkedAPI yet";
  if (account.status === "active") return `ready to post as ${account.name}`;
  if (account.status === "reconnection_required") {
    return account.reconnectionLink ? `needs reconnection: open ${account.reconnectionLink}` : "needs reconnection (no link returned)";
  }
  if (account.status === "frozen") return "account is frozen (LinkedAPI subscription downgraded or expired)";
  return `unknown account status for ${account.name}`;
}
