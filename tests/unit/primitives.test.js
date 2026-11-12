import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  normalizePin,
  isValidPin,
} from "../../lib/normalize.js";
import { hashPin, verifyPin } from "../../lib/pin.js";
import { signSession, verifySession } from "../../lib/session.js";

test("normalizeName strips diacritics, unifies alef, collapses spaces", () => {
  assert.equal(normalizeName("  أَحمد   بن  علي "), "احمد بن علي");
  assert.equal(normalizeName("إيمان"), normalizeName("ايمان"));
  assert.equal(normalizeName("آمنة"), normalizeName("امنه"));
});

test("normalizeName unifies taa marbuta and alef maqsura and tatweel", () => {
  assert.equal(normalizeName("فاطمة"), normalizeName("فاطمه"));
  assert.equal(normalizeName("هدى"), normalizeName("هدي"));
  assert.equal(normalizeName("محـمد"), normalizeName("محمد"));
});

test("normalizeName lowercases Latin", () => {
  assert.equal(normalizeName(" Sara  ALI "), "sara ali");
});

test("normalizePin maps Arabic-Indic and Persian digits", () => {
  assert.equal(normalizePin("١٢٣٤"), "1234");
  assert.equal(normalizePin("۱۲۳۴"), "1234");
  assert.equal(normalizePin(" 12 34 "), "1234");
});

test("isValidPin accepts exactly four digits after normalizing", () => {
  assert.equal(isValidPin("١٢٣٤"), true);
  assert.equal(isValidPin("0000"), true);
  assert.equal(isValidPin("123"), false);
  assert.equal(isValidPin("12345"), false);
  assert.equal(isValidPin("12a4"), false);
  assert.equal(isValidPin(undefined), false);
});

test("hashPin is salted and verifyPin checks it", async () => {
  const h1 = await hashPin("1234");
  const h2 = await hashPin("1234");
  assert.notEqual(h1, h2);
  assert.match(h1, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
  assert.equal(await verifyPin("1234", h1), true);
  assert.equal(await verifyPin("1235", h1), false);
  assert.equal(await verifyPin("1234", "garbage"), false);
});

test("session round-trips, rejects tampering and expiry", () => {
  const now = 1_000_000;
  const tok = signSession({ sid: "abc" }, "secret-1", 60, now);
  assert.equal(verifySession(tok, "secret-1", now + 10_000).sid, "abc");
  const flipped =
    tok.slice(0, -2) + (tok.at(-2) === "A" ? "B" : "A") + tok.at(-1);
  assert.equal(verifySession(flipped, "secret-1", now), null);
  assert.equal(verifySession(tok, "secret-2", now), null);
  assert.equal(verifySession(tok, "secret-1", now + 61_000), null);
  assert.equal(verifySession("", "secret-1", now), null);
  assert.equal(verifySession(undefined, "secret-1", now), null);
});
