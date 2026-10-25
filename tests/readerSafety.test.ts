// Reader text that reaches his call (lib/readerSafety.ts): no links, numbers, money, accounts
// or contact instructions in the reader questions or the line Pip reads aloud. EN + ES.
import { test } from "node:test";
import assert from "node:assert/strict";

import { safeFeedback, unsafeReaderText } from "../convex/lib/readerSafety.ts";

test("normal reader questions and lines pass (EN + ES)", () => {
  for (const ok of [
    "How did you price bread back then?",
    "Forty people liked your bakery story, and one reader asked how you priced bread back then.",
    "What changed for bakers between 1950-1960?",
    "What was the hardest lesson from your first year as a manager?",
    "¿Cómo aprendió a hornear pan de masa madre?",
    "A cuarenta personas les gustó su historia de la panadería.",
    "¿Qué fue lo más difícil de abrir su propio taller en 1975?",
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
    "Would you buy a gift card for me?",
    "What's your bank account number?",
    "Please share your password",
    "Call me tomorrow",
    "Text this number to win",
    "DM me about an opportunity",
    "Contact my assistant",
    "¿Me puede mandar dinero?",
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
