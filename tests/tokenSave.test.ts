// Compare-and-swap for refreshed tokens (lib/tokenSave.ts): xAuth.saveRefreshedTokens and
// oauth.updateTokens save only over the tokens they refreshed from.
import { test } from "node:test";
import assert from "node:assert/strict";

import { THREADS_SAVE_STATUSES, X_SAVE_STATUSES, canSaveRefreshed } from "../convex/lib/tokenSave.ts";

const row = (status: string, iv: string | null) => ({ status, secret: iv ? { ciphertext: "c", iv } : null });

test("X: same IV while connected or just marked invalid by a racing run", () => {
  assert.equal(canSaveRefreshed(row("connected", "iv0"), "iv0", X_SAVE_STATUSES), true);
  assert.equal(canSaveRefreshed(row("invalid", "iv0"), "iv0", X_SAVE_STATUSES), true);
  assert.equal(canSaveRefreshed(row("connected", "iv1"), "iv0", X_SAVE_STATUSES), false, "another run or a reconnect saved first");
  assert.equal(canSaveRefreshed(row("disconnected", "iv0"), "iv0", X_SAVE_STATUSES), false, "a disconnect wins");
  assert.equal(canSaveRefreshed(row("disconnected", null), "iv0", X_SAVE_STATUSES), false);
  assert.equal(canSaveRefreshed(null, "iv0", X_SAVE_STATUSES), false);
});

test("Threads: same IV and still connected; a fresh reconnect (new IV) is never overwritten", () => {
  assert.equal(canSaveRefreshed(row("connected", "iv0"), "iv0", THREADS_SAVE_STATUSES), true);
  assert.equal(canSaveRefreshed(row("connected", "iv-reconnect"), "iv0", THREADS_SAVE_STATUSES), false);
  assert.equal(canSaveRefreshed(row("invalid", "iv0"), "iv0", THREADS_SAVE_STATUSES), false);
  assert.equal(canSaveRefreshed(row("connected", "iv0"), "", THREADS_SAVE_STATUSES), false);
});
