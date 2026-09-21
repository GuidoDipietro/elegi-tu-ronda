import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBooking, validateCapacity } from "../src/domain.ts";

const events = [
  {
    id: "555bf",
    name: "5x5x5 Blindfolded",
    label: "5BLD",
    rounds: [1, 2] as const,
  },
];
const request = {
  eventId: "555bf",
  round: 2,
  events,
  capacity: 10,
  occupancy: 9,
  existingBooking: false,
};

test("allows R2 without requiring R1", () => {
  assert.deepEqual(validateBooking(request), { eventId: "555bf", round: 2 });
});
test("rejects a new booking when the Slot is full or over capacity", () => {
  for (const occupancy of [10, 11]) {
    assert.throws(() => validateBooking({ ...request, occupancy }), {
      code: "SLOT_FULL",
    });
  }
});
test("allows the owner to edit a booking in a full Slot", () => {
  assert.doesNotThrow(() =>
    validateBooking({ ...request, occupancy: 10, existingBooking: true }),
  );
});
test("a zero capacity Slot cannot accept new bookings", () => {
  assert.throws(
    () => validateBooking({ ...request, capacity: 0, occupancy: 0 }),
    { code: "SLOT_FULL" },
  );
});
test("rejects unknown events and rounds", () => {
  for (const eventId of ["", "333", null]) {
    assert.throws(() => validateBooking({ ...request, eventId }), {
      code: "INVALID_EVENT",
    });
  }
  for (const round of [0, 3, "1", null]) {
    assert.throws(() => validateBooking({ ...request, round }), {
      code: "INVALID_ROUND",
    });
  }
});
test("capacities must be nonnegative safe integers", () => {
  for (const capacity of [
    -1,
    1.5,
    NaN,
    Infinity,
    "10",
    null,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => validateCapacity(capacity), {
      code: "INVALID_CAPACITY",
    });
  }
  assert.equal(validateCapacity(0), 0);
  assert.equal(validateCapacity(10), 10);
});
