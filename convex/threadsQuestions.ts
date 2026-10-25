// Threads keyword search + quote-post answers. OFF unless THREADS_KEYWORD_SEARCH=on (needs
// Meta app review for threads_keyword_search). Not wired into threadReplies.ts yet.
//   findForElder({ elderId, keywords })    recent Threads questions for his keywords (returned, not stored)
//   postQuoteAnswer({ elderId, quotePostId, body, lang })   his answer as a quote post + disclosure
// Pure side: lib/threadsQuestions.ts. Never log tokens or post text.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { FetchFn } from "./lib/blueskyClient";
import { reportThreadsLoginError, threadsLoginForElder } from "./lib/threadsLogin";
import { postThreadsQuote, quoteAnswerText, searchThreadsQuestions, threadsKeywordSearchOn, type QuoteOutcome, type ThreadsQuestion } from "./lib/threadsQuestions";

declare const process: { env: Record<string, string | undefined> };

const OFF = "Threads keyword search is off (THREADS_KEYWORD_SEARCH; needs Meta app review).";

const timedFetch: FetchFn = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export const findForElder = internalAction({
  args: { elderId: v.id("elders"), keywords: v.array(v.string()) },
  handler: async (ctx, { elderId, keywords }): Promise<{ status: "off" | "no_login" | "ok"; questions: ThreadsQuestion[]; errors: string[] }> => {
    if (!threadsKeywordSearchOn(process.env)) return { status: "off", questions: [], errors: [OFF] };
    const login = await threadsLoginForElder(ctx, elderId, { fetchFn: timedFetch });
    if (!login) return { status: "no_login", questions: [], errors: [] };
    const found = await searchThreadsQuestions(timedFetch, login, keywords, Date.now());
    return { status: "ok", ...found };
  },
});

export const postQuoteAnswer = internalAction({
  args: { elderId: v.id("elders"), quotePostId: v.string(), body: v.string(), lang: v.union(v.literal("en"), v.literal("es")) },
  handler: async (ctx, { elderId, quotePostId, body, lang }): Promise<QuoteOutcome> => {
    if (!threadsKeywordSearchOn(process.env)) return { status: "failed", error: OFF };
    const login = await threadsLoginForElder(ctx, elderId, { fetchFn: timedFetch });
    const out = await postThreadsQuote(timedFetch, login, { quotePostId, text: quoteAnswerText(body, lang) });
    if (out.status === "failed" && /code 190\b|HTTP 401/.test(out.error)) await reportThreadsLoginError(ctx, elderId, { status: 401 });
    console.log(`threadsQuestions.postQuoteAnswer: elder ${elderId} ${out.status}`);
    return out;
  },
});
