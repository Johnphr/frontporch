// Compare-and-swap for refreshed OAuth tokens (X: xAuth.saveRefreshedTokens, Threads:
// oauth.updateTokens). Save only over the exact tokens we refreshed from (same IV), so a slow
// refresh can't overwrite a newer token from another run or a fresh reconnect. Pure: tests/tokenSave.test.ts.

export type TokenRow = { status: string; secret?: { iv: string } | null } | null | undefined;

/** X: also over "invalid", because a racing run can mark it invalid with the same IV just before we save. */
export const X_SAVE_STATUSES = ["connected", "invalid"] as const;
/** Threads: only while connected (a disconnect or an invalid mark wins). */
export const THREADS_SAVE_STATUSES = ["connected"] as const;

/** May the refreshed tokens be saved over this row? */
export function canSaveRefreshed(row: TokenRow, expectedIv: string, statuses: readonly string[]): boolean {
  return !!row && !!expectedIv && row.secret?.iv === expectedIv && statuses.includes(row.status);
}
