// His page on the web (public): read his host + weekly call slot, change the slot, list his
// published posts. Host changes go through signup.setCharacter.
//
// Same risk as signup.ts: there is no real sign-in yet, so the elderId is the only key. These
// return only what his page shows (name, host, slot, posts already public on LinkedIn), never
// his phone, transcripts or held drafts. Replace elderId with a session once sign-in exists.

import { ConvexError, v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { characterFor } from "./lib/characters";
import { prepareLinkedInText } from "./lib/linkedinPost";
import { callLanguage } from "./lib/onboarding";
import { normalizeSchedule } from "./lib/signupRules";

const MAX_POSTS = 50;

type Profile = {
  name: string;
  characterId: string;
  callDay?: string;
  callHour?: number;
  timezone?: string;
};

type PublishedPost = {
  id: string;
  text: string;
  linkedinUrl?: string;
  postedAt: number;
  reactions: number;
  comments: number;
};

export const getProfile = query({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<Profile | null> => {
    const elder = await ctx.db.get(elderId);
    if (!elder) return null;
    return {
      name: elder.name,
      characterId: characterFor(elder.characterId, callLanguage(elder.language)).id,
      ...(elder.callDay ? { callDay: elder.callDay } : {}),
      ...(elder.callHour !== undefined ? { callHour: elder.callHour } : {}),
      ...(elder.timezone ? { timezone: elder.timezone } : {}),
    };
  },
});

/** His weekly call: day (sunday..saturday), hour 0-23 his local time, IANA timezone. */
export const setSchedule = mutation({
  args: { elderId: v.id("elders"), callDay: v.string(), callHour: v.number(), timezone: v.string() },
  handler: async (ctx, { elderId, callDay, callHour, timezone }): Promise<null> => {
    const slot = normalizeSchedule(callDay, callHour, timezone);
    if (!slot) throw new ConvexError("Please choose a day and a time for the call.");
    if (!(await ctx.db.get(elderId))) throw new ConvexError("Sign-up not found.");
    await ctx.db.patch(elderId, slot);
    return null;
  },
});

/** His published posts, newest first, with reaction and comment counts. */
export const listPosts = query({
  args: { elderId: v.id("elders") },
  handler: async (ctx, { elderId }): Promise<PublishedPost[]> => {
    const posts = await ctx.db
      .query("posts")
      .withIndex("by_elder", (q) => q.eq("elderId", elderId))
      .order("desc")
      .collect();
    const published = posts.filter((p) => p.status === "published").slice(0, MAX_POSTS);
    return Promise.all(
      published.map(async (p) => {
        const url = p.linkedinUrl;
        const engagement = url
          ? await ctx.db
              .query("engagement")
              .withIndex("by_url", (q) => q.eq("linkedinUrl", url))
              .first()
          : null;
        let text = p.text;
        try {
          text = prepareLinkedInText(p.text).text;
        } catch {
          // empty or oversized text: show it as saved
        }
        return {
          id: p._id,
          text,
          ...(url ? { linkedinUrl: url } : {}),
          postedAt: p.approvedAt ?? p._creationTime,
          reactions: engagement?.reactions ?? 0,
          comments: engagement?.comments.length ?? 0,
        };
      }),
    );
  },
});
