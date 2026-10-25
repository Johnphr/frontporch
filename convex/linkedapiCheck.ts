// Read-only LinkedIn connection check: is LINKEDAPI_TOKEN valid, which LinkedIn accounts are
// connected to LinkedAPI, does LINKEDAPI_ID_TOKEN belong to one of them, and (with an elderId)
// can we post as that elder right now?
//
//   npx convex run linkedapiCheck:checkConnection '{}'
//   npx convex run linkedapiCheck:checkConnection '{"elderId":"<elders id>"}'
//
// Only calls LinkedAPI's Admin endpoint `POST /admin/accounts.getAll` (no workflow, nothing is
// posted). Note from LinkedAPI's docs: for an account in `reconnection_required`, that call
// creates a reconnection session if none exists, so a reconnection link can be returned.
// Never returns or logs a token. Env: LINKEDAPI_TOKEN, LINKEDAPI_ID_TOKEN. Owner: Integrations.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import {
  ACCOUNTS_GET_ALL_URL,
  elderVerdict,
  matchElderAccount,
  matchIdToken,
  parseAccountsResponse,
  type SafeAccount,
} from "./lib/linkedapiAccounts";

declare const process: { env: Record<string, string | undefined> };

const REQUEST_TIMEOUT_MS = 15_000;

type CheckResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      workspaceTokenValid: true;
      accounts: SafeAccount[];
      pendingConnectionSessions: number;
      idToken: { set: boolean; matchesAccount?: { id: string; name: string; status: string } };
      elder?: { linkedinUrl?: string; account?: { id: string; name: string; status: string }; verdict: string };
    };

export const getElderLinkedin = internalQuery({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<{ found: boolean; linkedinUrl?: string }> => {
    const elder = await ctx.db.get(elderId);
    if (!elder) return { found: false };
    return elder.linkedinUrl ? { found: true, linkedinUrl: elder.linkedinUrl } : { found: true };
  },
});

export const checkConnection = internalAction({
  args: { elderId: v.optional(v.id("elders")) },
  handler: async (ctx, { elderId }): Promise<CheckResult> => {
    const token = process.env.LINKEDAPI_TOKEN;
    const idToken = process.env.LINKEDAPI_ID_TOKEN;
    if (!token) return { ok: false, reason: "LINKEDAPI_TOKEN is not set in Convex (npx convex env set LINKEDAPI_TOKEN <token>)" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let status = 0;
    let body: unknown = null;
    try {
      const res = await fetch(ACCOUNTS_GET_ALL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "linked-api-token": token },
        body: "{}",
        signal: controller.signal,
      });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return { ok: false, reason: aborted ? "LinkedAPI didn't answer in 15 s" : "Couldn't reach LinkedAPI" };
    } finally {
      clearTimeout(timer);
    }

    const parsed = parseAccountsResponse(status, body);
    if (!parsed.ok) return parsed;

    const idMatch = matchIdToken(parsed.accounts, parsed.tokens, idToken);
    const result: CheckResult = {
      ok: true,
      workspaceTokenValid: true,
      accounts: parsed.accounts,
      pendingConnectionSessions: parsed.pendingSessions,
      idToken: {
        set: Boolean(idToken),
        ...(idMatch ? { matchesAccount: { id: idMatch.id, name: idMatch.name, status: idMatch.status } } : {}),
      },
    };

    if (elderId) {
      const elder = await ctx.runQuery(internal.linkedapiCheck.getElderLinkedin, { elderId });
      if (!elder.found) {
        result.elder = { verdict: "no elder with that id" };
      } else {
        const account = matchElderAccount(parsed.accounts, elder.linkedinUrl);
        result.elder = {
          ...(elder.linkedinUrl ? { linkedinUrl: elder.linkedinUrl } : {}),
          ...(account ? { account: { id: account.id, name: account.name, status: account.status } } : {}),
          verdict: elderVerdict(elder.linkedinUrl, account),
        };
      }
    }
    console.log(
      `linkedapiCheck: ${parsed.accounts.length} account(s), id token ${idMatch ? "matches" : idToken ? "doesn't match" : "not set"}`,
    );
    return result;
  },
});
