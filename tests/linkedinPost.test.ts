// Run: node --test tests/   (Node 22.18+ / 24 strips TypeScript types natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_DISCLOSURE,
  FOLD_CHARS,
  LINKEDIN_MAX_CHARS,
  MAX_POLL_ATTEMPTS,
  capHashtags,
  elderWords,
  parseGuardMode,
  pollDelayMs,
  prepareLinkedInText,
  stripMarkdown,
  truncate,
} from "../convex/lib/linkedinPost.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/sample_transcript.json", import.meta.url), "utf8"),
);

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

test("strips markdown LinkedIn would show raw", () => {
  const out = stripMarkdown("# Title\n**bold** and __strong__ and *soft*\n- one\n* two\n> quote\n[site](https://x.org)");
  assert.equal(out, "Title\nbold and strong and soft\n• one\n• two\nquote\nsite (https://x.org)");
});

test("keeps hashtags and inline asterisks intact", () => {
  assert.equal(stripMarkdown("#leadership matters 5 * 3"), "#leadership matters 5 * 3");
});

test("caps hashtags at 3, keeping the first distinct ones", () => {
  const { text, removed } = capHashtags("a #One b #two #one #three #four", 3);
  assert.deepEqual(removed, ["#one", "#four"]);
  assert.equal(text.replace(/\s+/g, " ").trim(), "a #One b #two #three");
});

test("fixture post: plain text, 3 hashtags, disclosure exactly once at the end", () => {
  const { text, warnings } = prepareLinkedInText(fixture.post);
  assert.ok(!text.includes("**"));
  assert.ok(text.includes("• You get there."));
  assert.equal((text.match(/#\w+/g) ?? []).length, 3);
  assert.ok(warnings.some((w) => w.includes("hashtag")));
  assert.ok(!text.includes("Written with the help of AI"), "writer's own disclosure is replaced");
  assert.equal(count(text, DEFAULT_DISCLOSURE), 1);
  assert.ok(text.endsWith(DEFAULT_DISCLOSURE));
});

test("disclosure is not duplicated when the text already has ours", () => {
  const once = prepareLinkedInText("A story.").text;
  const twice = prepareLinkedInText(once).text;
  assert.equal(count(twice, DEFAULT_DISCLOSURE), 1);
});

test("3,000-character limit is enforced without cutting the disclosure", () => {
  const long = "word ".repeat(1200); // ~6,000 chars
  const { text, warnings } = prepareLinkedInText(long);
  assert.ok(text.length <= LINKEDIN_MAX_CHARS, `got ${text.length}`);
  assert.ok(text.endsWith(DEFAULT_DISCLOSURE));
  assert.ok(text.includes("…"));
  assert.ok(warnings.some((w) => w.includes("3000")));
});

test("warns when the first line runs past the see-more fold", () => {
  const longFirst = "x".repeat(FOLD_CHARS + 10) + "\n\nrest";
  assert.ok(prepareLinkedInText(longFirst).warnings.some((w) => w.includes("First line")));
  assert.ok(!prepareLinkedInText("Short hook.\n\nrest").warnings.some((w) => w.includes("First line")));
});

test("normalizes whitespace and blank lines", () => {
  const { text } = prepareLinkedInText("Hook  line\r\n\r\n\r\n\tBody   text  ");
  assert.ok(text.startsWith("Hook line\n\nBody text\n\n"));
});

test("empty text throws", () => {
  assert.throws(() => prepareLinkedInText("   \n "), /empty/);
});

test("elderWords keeps only his turns (incl. Vapi 'user' role)", () => {
  const words = elderWords(fixture.turns);
  assert.ok(words.includes("we started at four"));
  assert.ok(!words.includes("What was a normal morning like"));
  assert.equal(elderWords([{ role: "user", text: "hi" }, { role: "assistant", text: "yo" }]), "hi");
});

test("truncate cuts on a word boundary", () => {
  assert.equal(truncate("one two three four", 12), "one two…");
  assert.equal(truncate("short", 10), "short");
});

test("guard mode defaults to enforce", () => {
  assert.equal(parseGuardMode(undefined), "enforce");
  assert.equal(parseGuardMode("WARN"), "warn");
  assert.equal(parseGuardMode("off"), "off");
  assert.equal(parseGuardMode("nonsense"), "enforce");
});

test("poll backoff grows, caps, and waits long outside working hours", () => {
  assert.equal(pollDelayMs(0), 20_000);
  assert.equal(pollDelayMs(1), 40_000);
  assert.equal(pollDelayMs(100), 300_000);
  assert.equal(pollDelayMs(0, "outsideWorkingHours"), 1_800_000);
  assert.ok(MAX_POLL_ATTEMPTS > 10);
});

// ---------- review fixes ----------

test("story lines that mention AI are never treated as disclosures", () => {
  const story =
    "In 1987 we created the first AI group at the plant, with six engineers and one borrowed computer.\n\n" +
    "I have written about AI before, but never about the people.\n\nWhat was your first team like?";
  const { text, warnings } = prepareLinkedInText(story);
  assert.ok(text.includes("In 1987 we created the first AI group at the plant"));
  assert.ok(text.includes("I have written about AI before"));
  assert.ok(!warnings.some((w) => w.includes("disclosure")));
});

test("a disclosure-like line in the middle of the post is kept", () => {
  const post = "Hook.\n\nWritten with AI help, this line sits mid-story.\n\nMore story.\n\nClosing question?";
  assert.ok(prepareLinkedInText(post).text.includes("Written with AI help, this line sits mid-story."));
});

test("long lines at the end are not stripped even if they mention AI", () => {
  const long = "Written up with AI " + "and a lot of other words about the old days at the plant ".repeat(4);
  assert.ok(long.length > 160);
  assert.ok(prepareLinkedInText(`Story.\n\n${long}`).text.includes(long.trim()));
});

test("the writer's disclosure is replaced with a warning; Spanish too", () => {
  for (const line of ["Made with AI.", "Escrito con ayuda de IA.", "Hecho con IA a partir de sus palabras."]) {
    const { text, warnings } = prepareLinkedInText(`Una historia.\n\n${line}`);
    assert.ok(!text.includes(line), `should remove: ${line}`);
    assert.equal(count(text, DEFAULT_DISCLOSURE), 1);
    assert.ok(warnings.some((w) => w.includes("disclosure")), `should warn for: ${line}`);
  }
});

test("our own disclosure is not reported as replaced", () => {
  const once = prepareLinkedInText("A story.").text;
  assert.ok(!prepareLinkedInText(once).warnings.some((w) => w.includes("disclosure")));
});

test("number-only tags like #1 are not hashtags and don't use up a slot", () => {
  const { text, removed } = capHashtags("I was #1 in sales #grit #work #craft #extra", 3);
  assert.ok(text.includes("#1"));
  assert.deepEqual(removed, ["#extra"]);
});

test("bullets and headings after a blank line keep the blank line", () => {
  assert.equal(stripMarkdown("Intro\n\n- one\n- two"), "Intro\n\n• one\n• two");
  assert.equal(stripMarkdown("Intro\n\n# Heading"), "Intro\n\nHeading");
});

test("truncate never leaves half an emoji", () => {
  const out = truncate("a".repeat(10) + "😀".repeat(20), 26);
  const body = out.replace(/…$/, "");
  const last = body.charCodeAt(body.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), "ends on a lone high surrogate");
  assert.ok(out.length <= 26);
});
