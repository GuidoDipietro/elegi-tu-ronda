import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, timeLabel, scheduleCsv } from "../src/format.ts";
import { seedEvents, seedSlots } from "../src/config.ts";

test("formats published Slots in Buenos Aires time regardless of server timezone", () => {
  assert.equal(timeLabel("2026-10-24T18:30:00Z"), "15:30");
  assert.equal(timeLabel(seedSlots.at(-1)!.startsAt), "19:00");
});
test("CSV escapes quotes and neutralizes spreadsheet formulas", () => {
  assert.equal(csvCell('Ana, "A"'), '"Ana, ""A"""');
  assert.equal(csvCell("=1+1"), '"\'=1+1"');
  assert.equal(csvCell("  @SUM(A1)"), '"\'  @SUM(A1)"');
});
test("exports a full competitor matrix including empty cells", () => {
  const csv = scheduleCsv({
    events: seedEvents,
    slots: seedSlots
      .slice(0, 2)
      .map((s) => ({ ...s, occupancy: 1, booking: null })),
    locked: false,
    competitor: null,
    competitors: [{ id: "a", name: "Alex", wcaId: null }],
    bookings: [
      { competitorId: "a", slotId: "slot-a", eventId: "555bf", round: 2 },
    ],
  });
  assert.ok(csv.startsWith('\uFEFF"Competidor","WCA ID","15:30","16:00"'));
  assert.ok(csv.includes('"Alex","","5BLD R2",""'));
});
