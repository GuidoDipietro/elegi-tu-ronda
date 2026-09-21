import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, requireId, validateBooking } from "../src/domain.ts";
import { seedEvents } from "../src/config.ts";

test("normalizes case, accents, Unicode width and whitespace for returning names", () => {
  assert.equal(
    normalizeName("  José   PÉREZ  ").key,
    normalizeName("jose perez").key,
  );
  assert.equal(normalizeName("Ａlex García").key, "alex garcia");
  assert.equal(normalizeName("  José   PÉREZ  ").name, "José PÉREZ");
});
test("rejects missing, short, long, and invisible names", () => {
  for (const name of [null, "", " ", "a", "x".repeat(101), "Alex\u200b"]) {
    assert.throws(() => normalizeName(name), { code: "INVALID_NAME" });
  }
});
test("rejects malformed competitor identifiers", () => {
  assert.equal(
    requireId("00000000-0000-0000-0000-000000000001"),
    "00000000-0000-0000-0000-000000000001",
  );
  for (const value of [null, "", 1, "' OR true", "123"])
    assert.throws(() => requireId(value), { code: "INVALID_PERSON" });
});
test("FTO exposes only R1 while the eight official events expose R1 and R2", () => {
  assert.equal(seedEvents.length, 9);
  for (const event of seedEvents)
    assert.deepEqual(event.rounds, event.id === "fto" ? [1] : [1, 2]);
  const input = {
    events: seedEvents,
    eventId: "fto",
    round: 1,
    capacity: 10,
    occupancy: 0,
    existingBooking: false,
  };
  assert.doesNotThrow(() => validateBooking(input));
  assert.throws(() => validateBooking({ ...input, round: 2 }), {
    code: "INVALID_ROUND",
  });
});
