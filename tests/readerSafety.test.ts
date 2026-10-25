// Reader text that reaches his call (lib/readerSafety.ts): no links, numbers, money, accounts
// or contact instructions in the reader questions or the line Pip reads aloud. EN + ES.
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_QUOTED_COMMENTS, quotableComments, safeFeedback, unsafeReaderText } from "../convex/lib/readerSafety.ts";

test("normal reader questions and lines pass (EN + ES)", () => {
  for (const ok of [
    "How did you price bread back then?",
    "Forty people liked your bakery story, and one reader asked how you priced bread back then.",
    "What changed for bakers between 1950-1960?",
    "What was the hardest lesson from your first year as a manager?",
    "¿Cómo aprendió a hornear pan de masa madre?",
    "A cuarenta personas les gustó su historia de la panadería.",
    "¿Qué fue lo más difícil de abrir su propio taller en 1975?",
    // career talk about money, banks and calls must pass
    "How much did a loaf cost, and how did you pay your staff?",
    "When did you start at the bank, and what did you invest in first?",
    "How many calls a day did the shop take?",
    "Did you send your bread to other towns?",
    "¿Cuánto dinero ganaba un panadero en esos años?",
    "¿Cómo era trabajar en el banco en los setenta?",
  ]) {
    assert.equal(unsafeReaderText(ok), false, ok);
  }
});

test("links, phones, emails, @handles are caught", () => {
  for (const bad of [
    "Check out https://example.com for more",
    "visit www.example.org",
    "see mysite.io today",
    "My number is (415) 555-0123",
    "Llámeme al 81 1234 5678",
    "write to joe@example.com",
    "Follow @scammer99 for tips",
  ]) {
    assert.equal(unsafeReaderText(bad), true, bad);
  }
});

test("money, payments, accounts, passwords, contact instructions are caught (EN + ES)", () => {
  for (const bad of [
    "Can you send me $50?",
    "Send money to my PayPal",
    "Would you buy a gift card for me?",
    "What's your bank account number?",
    "Please share your password",
    "Call me tomorrow",
    "Text me at this number to win",
    "DM me about an opportunity",
    "Contact my assistant",
    "Mándeme dinero, por favor",
    "Necesito su contraseña",
    "Haga una transferencia a mi cuenta bancaria",
    "Escríbeme por WhatsApp",
    "Envíame los datos de tu tarjeta",
    "Contácteme hoy",
    "Llámeme mañana",
  ]) {
    assert.equal(unsafeReaderText(bad), true, bad);
  }
});

test("safeFeedback drops unsafe questions and blanks an unsafe line / resonated", () => {
  const out = safeFeedback({
    resonated: "Readers loved the bakery story.",
    readerQuestions: ["How did you price bread?", "Can you call me at 415 555 0123?", "Send $20 to my PayPal"],
    line: "One reader asked you to visit bit.ly/abc.",
  });
  assert.deepEqual(out, { resonated: "Readers loved the bakery story.", readerQuestions: ["How did you price bread?"], line: "" });
  assert.equal(safeFeedback({ resonated: "Readers want your email.", readerQuestions: [], line: "" }).resonated, "");
});

test("quotableComments: exact words (rude ones too), no links or contact asks, newest few", () => {
  const out = quotableComments([
    { text: "I dont believe this. Is full of shit" },
    { text: "  You shoulve stayed\nin prison ashole " },
    { text: "Great story, see more at www.example.com" },
    { text: "DM me for a deal" },
    { text: "x".repeat(301) }, // too long to quote whole: dropped, never cut
  ]);
  assert.equal(out, '- "I dont believe this. Is full of shit"\n- "You shoulve stayed in prison ashole"');
  const many = Array.from({ length: 8 }, (_, i) => ({ text: `comment ${String.fromCharCode(97 + i)}` }));
  assert.equal(quotableComments(many).split("\n").length, MAX_QUOTED_COMMENTS);
  assert.match(quotableComments(many), /comment h"$/); // newest kept
  assert.equal(quotableComments([]), "");
});
