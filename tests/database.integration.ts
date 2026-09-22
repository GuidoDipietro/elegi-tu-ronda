import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { Planner } from "../src/server/service.ts";
import { seedEvents, seedSlots } from "../src/config.ts";
import { handle } from "../src/server/handler.ts";
import { database } from "../src/server/db.ts";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a disposable database whose name ends in _test.",
  );
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 24,
});
const planner = new Planner(pool);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ADMIN_PASSWORD = "integration-test-password";

before(async () => {
  const result = await pool.query("SELECT current_database() AS name");
  if (!result.rows[0].name.endsWith("_test"))
    throw new Error("Refusing to reset a database without a _test suffix.");
  await pool.query("DROP SCHEMA IF EXISTS planner CASCADE");
  await pool.query(
    await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"),
  );
  for (const [position, event] of seedEvents.entries()) {
    await pool.query(
      "INSERT INTO planner.events(id,name,label,position,rounds) VALUES ($1,$2,$3,$4,$5)",
      [event.id, event.name, event.label, position, event.rounds],
    );
  }
  for (const slot of seedSlots)
    await pool.query(
      "INSERT INTO planner.slots(id,label,starts_at,capacity) VALUES ($1,$2,$3,$4)",
      [slot.id, slot.label, slot.startsAt, slot.capacity],
    );
});
beforeEach(async () => {
  await pool.query("TRUNCATE planner.bookings, planner.competitors CASCADE");
  await pool.query("UPDATE planner.slots SET capacity=10");
  await pool.query("UPDATE planner.settings SET locked=false, max_slots=2");
});
after(async () => {
  await pool.end();
  await database().end();
});
const booking = (competitorId: string, extra = {}) => ({
  competitorId,
  slotId: "slot-a",
  eventId: "555bf",
  round: 2,
  ...extra,
});

test("re-entering a normalized name reuses the identity and imported WCA ID", async () => {
  await planner.importRoster([{ name: "José Pérez", wcaId: "2026TEST01" }]);
  const first = await planner.identify("  JOSE   perez ");
  const second = await planner.identify("2026test01");
  assert.equal(first.id, second.id);
  assert.equal(first.name, "José Pérez");
  assert.equal(
    (await pool.query("SELECT * FROM planner.competitors")).rowCount,
    1,
  );
});
test("R2 before R1 and the same event-round in multiple Slots are allowed", async () => {
  const person = await planner.identify("Test Person");
  await planner.save(booking(person.id));
  await planner.save(booking(person.id, { slotId: "slot-b" }));
  const state = await planner.state(person.id);
  assert.equal(state.slots.filter((s) => s.booking).length, 2);
  assert.equal(state.slots[0].booking?.round, 2);
});
test("editing a full Slot replaces the booking without using another place", async () => {
  const person = await planner.identify("Test Person");
  await planner.capacity("slot-a", 1);
  await planner.save(booking(person.id));
  await planner.save(booking(person.id, { eventId: "222", round: 1 }));
  const state = await planner.state(person.id);
  assert.equal(state.slots[0].occupancy, 1);
  assert.equal(state.slots[0].booking?.eventId, "222");
});
test("20 simultaneous requests for the last place produce exactly one winner", async () => {
  await planner.capacity("slot-a", 1);
  const people = await Promise.all(
    Array.from({ length: 20 }, (_, i) => planner.identify(`Competitor ${i}`)),
  );
  const results = await Promise.allSettled(
    people.map((p) => planner.save(booking(p.id))),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason.code === "SLOT_FULL",
    ).length,
    19,
  );
  assert.equal((await planner.state(null)).slots[0].occupancy, 1);
});
test("the database trigger also prevents concurrent overbooking via direct SQL", async () => {
  await planner.capacity("slot-a", 1);
  const people = await Promise.all(
    Array.from({ length: 12 }, (_, i) => planner.identify(`Direct ${i}`)),
  );
  const results = await Promise.allSettled(
    people.map((p) =>
      pool.query(
        "INSERT INTO planner.bookings(competitor_id,slot_id,event_id,round) VALUES ($1,'slot-a','222',1)",
        [p.id],
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason.message === "SLOT_FULL",
    ).length,
    11,
  );
});
test("simultaneous repeated saves for the same person remain one booking", async () => {
  const person = await planner.identify("Test Person");
  await planner.capacity("slot-a", 1);
  await Promise.all(
    Array.from({ length: 8 }, () => planner.save(booking(person.id))),
  );
  assert.equal((await planner.state(person.id)).slots[0].occupancy, 1);
});
test("lowering capacity keeps existing bookings, permits edits and blocks new people", async () => {
  const first = await planner.identify("First Person");
  const second = await planner.identify("Second Person");
  await planner.save(booking(first.id));
  await planner.capacity("slot-a", 0);
  await planner.save(booking(first.id, { round: 1 }));
  await assert.rejects(planner.save(booking(second.id)), { code: "SLOT_FULL" });
  const state = await planner.state(first.id);
  assert.equal(state.slots[0].capacity, 0);
  assert.equal(state.slots[0].occupancy, 1);
});
test("cancellation is idempotent and immediately releases a place", async () => {
  const first = await planner.identify("First Person");
  const second = await planner.identify("Second Person");
  await planner.capacity("slot-a", 1);
  await planner.save(booking(first.id));
  await planner.remove(booking(first.id));
  await planner.remove(booking(first.id));
  await planner.save(booking(second.id));
  assert.equal((await planner.state(second.id)).slots[0].occupancy, 1);
});
test("FTO R2 and malformed event/round combinations fail in service and database", async () => {
  const person = await planner.identify("Test Person");
  await assert.rejects(
    planner.save(booking(person.id, { eventId: "fto", round: 2 })),
    { code: "INVALID_ROUND" },
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO planner.bookings(competitor_id,slot_id,event_id,round) VALUES ($1,'slot-a','fto',2)",
      [person.id],
    ),
    /INVALID_EVENT_ROUND/,
  );
  await assert.rejects(
    planner.save(booking(person.id, { eventId: "unknown" })),
    { code: "INVALID_EVENT" },
  );
  await planner.save(booking(person.id, { eventId: "fto", round: 1 }));
});
test("closed reservations reject competitor writes but allow explicit admin edits", async () => {
  const person = await planner.identify("Test Person");
  await planner.save(booking(person.id));
  await planner.lock(true);
  await assert.rejects(planner.save(booking(person.id)), { code: "LOCKED" });
  await assert.rejects(planner.remove(booking(person.id)), { code: "LOCKED" });
  await planner.save(booking(person.id, { eventId: "222" }), true);
  await planner.remove(booking(person.id), true);
});
test("roster imports preserve reservations and reject duplicates before writing", async () => {
  const person = await planner.identify("Test Person");
  await planner.save(booking(person.id));
  await planner.importRoster([{ name: "Test Person", wcaId: "2026TEST01" }]);
  await planner.importRoster([{ name: "Test Person", wcaId: "2026TEST01" }]);
  assert.equal((await planner.state(person.id)).slots[0].booking?.round, 2);
  await assert.rejects(
    planner.importRoster([{ name: "New Person" }, { name: "new person" }]),
    { code: "INVALID_ROSTER" },
  );
  assert.equal(
    (await pool.query("SELECT * FROM planner.competitors")).rowCount,
    1,
  );
});
test("public state omits roster and other competitors’ bookings", async () => {
  const person = await planner.identify("Private Person");
  await planner.save(booking(person.id));
  const state = await planner.state(null);
  assert.equal(state.slots[0].occupancy, 1);
  assert.equal(state.slots[0].booking, null);
  assert.ok(!JSON.stringify(state).includes("Private Person"));
});
test("admin API is protected, validates origin, and accepts signed sessions", async () => {
  const request = (body: unknown, headers = {}) =>
    new Request("http://localhost/api/planner", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await handle(new Request("http://localhost/api/planner?action=admin")))
      .status,
    401,
  );
  assert.equal(
    (
      await handle(
        request({ action: "capacity", slotId: "slot-a", capacity: 0 }),
      )
    ).status,
    401,
  );
  assert.equal(
    (await handle(request({ action: "save", asAdmin: true }))).status,
    401,
  );
  assert.equal(
    (
      await handle(
        request(
          { action: "login", password: process.env.ADMIN_PASSWORD },
          { Origin: "https://other.example" },
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (await handle(request({ action: "login", password: "wrong" }))).status,
    401,
  );
  const response = await handle(
    request({ action: "login", password: process.env.ADMIN_PASSWORD }),
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  assert.equal(
    (
      await handle(
        new Request("http://localhost/api/planner?action=admin", {
          headers: { cookie },
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await handle(
        request(
          { action: "capacity", slotId: "slot-a", capacity: 0 },
          { cookie },
        ),
      )
    ).status,
    200,
  );
  assert.equal((await planner.state(null)).slots[0].capacity, 0);
});

test("limits serialize bookings across slots, including direct SQL and admin saves", async () => {
  const person = await planner.identify("Limit Person");
  await planner.limit(1);
  const results = await Promise.allSettled(seedSlots.map((s, i) => i % 2
    ? planner.save(booking(person.id, { slotId: s.id }), true)
    : pool.query("INSERT INTO planner.bookings(competitor_id,slot_id,event_id,round) VALUES ($1,$2,'222',1)", [person.id, s.id])));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.equal(r.reason.message, "BOOKING_LIMIT");
});
test("waves increase total allowance; lowering preserves edits; cancellations restore allowance", async () => {
  const person = await planner.identify("Wave Person");
  await planner.save(booking(person.id));
  await planner.save(booking(person.id, { slotId: "slot-b" }));
  await assert.rejects(planner.save(booking(person.id, { slotId: "slot-c" })), /BOOKING_LIMIT/);
  await planner.limit(4);
  for (const slotId of ["slot-c", "slot-d"]) await planner.save({ competitorId: person.id, slotId, eventId: "fto" });
  assert.equal((await planner.state(person.id)).maxSlots, 4);
  await planner.limit(1);
  await planner.save({ competitorId: person.id, slotId: "slot-a", eventId: "222" });
  assert.equal((await planner.state(person.id)).slots.filter((s) => s.booking).length, 4);
  await planner.limit(4);
  await planner.remove(booking(person.id));
  await planner.save(booking(person.id, { slotId: "slot-e" }));
  await planner.limit(0);
  await assert.rejects(planner.save(booking(person.id, { slotId: "slot-f" })), /BOOKING_LIMIT/);
});
test("limit API is protected, validates values, and returns conflict for stale clients", async () => {
  const post = (body: unknown, cookie = "") => handle(new Request("http://localhost/api/planner", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
  assert.equal((await post({ action: "limit", maxSlots: 4 })).status, 401);
  const login = await post({ action: "login", password: process.env.ADMIN_PASSWORD });
  const cookie = login.headers.get("set-cookie")!;
  for (const maxSlots of [-1, 1.5, "2", null, 2147483648]) assert.equal((await post({ action: "limit", maxSlots }, cookie)).status, 400);
  assert.equal((await post({ action: "limit", maxSlots: 0 }, cookie)).status, 200);
  const person = await planner.identify("Stale Client");
  const response = await post({ action: "save", competitorId: person.id, slotId: "slot-a", eventId: "222" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "BOOKING_LIMIT");
});
test("schema upgrade is repeatable and preserves configured limits and bookings", async () => {
  const person = await planner.identify("Migration Person");
  await planner.save(booking(person.id));
  await planner.limit(6);
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const state = await planner.state(person.id);
  assert.equal(state.maxSlots, 6);
  assert.equal(state.slots[0].booking?.round, 2);
});
