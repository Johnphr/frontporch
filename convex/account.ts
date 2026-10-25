// His page on the web (public): read his host + weekly call slot, change the slot, list his
// posts that went out. Host changes go through signup.setCharacter.
//
// Like signup.ts, every function needs his sign-up token (signup.register), not just his
// elderId. The public functions are actions: the token is hashed here (Web Crypto), then an
// internal query or mutation checks the hash (lib/accountPage.checkedElder). These return only
// what his page shows (name, host, slot, posts already public), never his phone, transcripts
// or held drafts. Replace the token with a real session once sign-in exists.

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import {
  MAX_POSTS,
  checkedElder,
  profileView,
  publishedPosts,
  scheduleChange,
  type Profile,
  type PublishedPost,
} from "./lib/accountPage";
import { signupTokenHash } from "./lib/signupRules";

const NOT_FOUND = "Sign-up not found.";
const BAD_SLOT = "Please choose a day and a time for the call.";
// Posts read per page load: enough for MAX_POSTS that went out, plus held or removed ones.
const POSTS_READ = 200;

const hashOf = async (token: string) => (await signupTokenHash(token)) ?? "";

/** { name, characterId, callDay?, callHour?, timezone? }, or null (unknown elder or wrong token). */
export const getProfile = action({
  args: { elderId: v.id("elders"), token: v.string() },
  handler: async (ctx, { elderId, token }): Promise<Profile | null> =>
    await ctx.runQuery(internal.account.profileFor, { elderId, tokenHash: await hashOf(token) }),
});

export const profileFor = internalQuery({
  args: { elderId: v.id("elders"), tokenHash: v.string() },
  handler: async (ctx, { elderId, tokenHash }): Promise<Profile | null> => profileView(await ctx.db.get(elderId), tokenHash),
});

/** His weekly call: day (sunday..saturday), hour 0-23 his local time, IANA timezone. */
export const setSchedule = action({
  args: { elderId: v.id("elders"), token: v.string(), callDay: v.string(), callHour: v.number(), timezone: v.string() },
  handler: async (ctx, { elderId, token, ...slot }): Promise<null> => {
    const res: { ok: true } | { ok: false; error: "invalid" | "not_found" } = await ctx.runMutation(internal.account.saveSchedule, {
      elderId,
      tokenHash: await hashOf(token),
      ...slot,
    });
    if (!res.ok) throw new ConvexError(res.error === "invalid" ? BAD_SLOT : NOT_FOUND);
    return null;
  },
});

export const saveSchedule = internalMutation({
  args: { elderId: v.id("elders"), tokenHash: v.string(), callDay: v.string(), callHour: v.number(), timezone: v.string() },
  handler: async (ctx, { elderId, tokenHash, callDay, callHour, timezone }): Promise<{ ok: true } | { ok: false; error: "invalid" | "not_found" }> => {
    const change = scheduleChange(await ctx.db.get(elderId), tokenHash, callDay, callHour, timezone);
    if (!change.ok) return change;
    await ctx.db.patch(elderId, change.slot);
    return { ok: true };
  },
});

/** His posts that went out, newest first: a link per platform, reactions and comments summed. */
export const listPosts = action({
  args: { elderId: v.id("elders"), token: v.string() },
  handler: async (ctx, { elderId, token }): Promise<PublishedPost[]> => {
    const posts: PublishedPost[] | null = await ctx.runQuery(internal.account.postsFor, { elderId, tokenHash: await hashOf(token) });
    if (!posts) throw new ConvexError(NOT_FOUND);
    return posts;
  },
});

export const postsFor = internalQuery({
  args: { elderId: v.id("elders"), tokenHash: v.string() },
  handler: async (ctx, { elderId, tokenHash }): Promise<PublishedPost[] | null> => {
    if (!checkedElder(await ctx.db.get(elderId), tokenHash)) return null;
    const rows = await ctx.db
      .query("posts")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .order("desc")
      .take(POSTS_READ);
    // Removed posts never show; skip their publications too.
    const live = rows.filter((p) => p.removedAt === undefined);
    const publications = (
      await Promise.all(live.map((p) => ctx.db.query("postPublications").withIndex("by_post", (q) => q.eq("postId", p._id)).collect()))
    ).flat();
    const engagement = await ctx.db
      .query("engagement")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .collect();
    return publishedPosts(
      live.map((p) => ({
        id: p._id,
        text: p.text,
        status: p.status,
        ...(p.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}),
        ...(p.removedAt !== undefined ? { removedAt: p.removedAt } : {}),
        ...(p.approvedAt !== undefined ? { approvedAt: p.approvedAt } : {}),
        createdAt: p._creationTime,
      })),
      publications.map((r) => ({
        postId: r.postId,
        platform: r.platform,
        status: r.status,
        ...(r.url ? { url: r.url } : {}),
        ...(r.postedAt !== undefined ? { postedAt: r.postedAt } : {}),
      })),
      engagement.map((e) => ({
        ...(e.postId ? { postId: e.postId } : {}),
        linkedinUrl: e.linkedinUrl,
        reactions: e.reactions,
        comments: e.comments.length,
        ...(e.goneAt !== undefined ? { goneAt: e.goneAt } : {}),
      })),
      MAX_POSTS,
    );
  },
});
