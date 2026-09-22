import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { Planner } from "../src/server/service.ts";
import { seedEvents, seedSlots } from "../src/config.ts";
import { handle } from "../src/server/handler.ts";
import {
  createCompetitorSession,
  cookieValue,
  digest,
} from "../src/server/wca-auth.ts";
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
  await pool.query(
    "TRUNCATE planner.bookings, planner.competitors, planner.oauth_states CASCADE",
  );
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
  const first = await planner.identifyWca({
    id: 100,
    name: "José Pérez",
    wcaId: "2026TEST01",
  });
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
  const person = await planner.identifyWca({
    id: 101,
    name: "Test Person",
    wcaId: "2026TEST01",
  });
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
  const results = await Promise.allSettled(
    seedSlots.map((s, i) =>
      i % 2
        ? planner.save(booking(person.id, { slotId: s.id }), true)
        : pool.query(
            "INSERT INTO planner.bookings(competitor_id,slot_id,event_id,round) VALUES ($1,$2,'222',1)",
            [person.id, s.id],
          ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results)
    if (r.status === "rejected")
      assert.equal(r.reason.message, "BOOKING_LIMIT");
});
test("waves increase total allowance; lowering preserves edits; cancellations restore allowance", async () => {
  const person = await planner.identify("Wave Person");
  await planner.save(booking(person.id));
  await planner.save(booking(person.id, { slotId: "slot-b" }));
  await assert.rejects(
    planner.save(booking(person.id, { slotId: "slot-c" })),
    /BOOKING_LIMIT/,
  );
  await planner.limit(4);
  for (const slotId of ["slot-c", "slot-d"])
    await planner.save({ competitorId: person.id, slotId, eventId: "fto" });
  assert.equal((await planner.state(person.id)).maxSlots, 4);
  await planner.limit(1);
  await planner.save({
    competitorId: person.id,
    slotId: "slot-a",
    eventId: "222",
  });
  assert.equal(
    (await planner.state(person.id)).slots.filter((s) => s.booking).length,
    4,
  );
  await planner.limit(4);
  await planner.remove(booking(person.id));
  await planner.save(booking(person.id, { slotId: "slot-e" }));
  await planner.limit(0);
  await assert.rejects(
    planner.save(booking(person.id, { slotId: "slot-f" })),
    /BOOKING_LIMIT/,
  );
});
test("limit API is protected, validates values, and returns conflict for stale clients", async () => {
  const post = (body: unknown, cookie = "") =>
    handle(
      new Request("http://localhost/api/planner", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      }),
    );
  assert.equal((await post({ action: "limit", maxSlots: 4 })).status, 401);
  const login = await post({
    action: "login",
    password: process.env.ADMIN_PASSWORD,
  });
  const cookie = login.headers.get("set-cookie")!;
  for (const maxSlots of [-1, 1.5, "2", null, 2147483648])
    assert.equal(
      (await post({ action: "limit", maxSlots }, cookie)).status,
      400,
    );
  assert.equal(
    (await post({ action: "limit", maxSlots: 0 }, cookie)).status,
    200,
  );
  const person = await planner.identify("Stale Client");
  const response = await post(
    {
      action: "save",
      competitorId: person.id,
      slotId: "slot-a",
      eventId: "222",
    },
    await createCompetitorSession(pool, person.id),
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "BOOKING_LIMIT");
});
test("schema upgrade is repeatable and preserves configured limits and bookings", async () => {
  const person = await planner.identify("Migration Person");
  await planner.save(booking(person.id));
  await planner.limit(6);
  await pool.query(
    await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"),
  );
  const state = await planner.state(person.id);
  assert.equal(state.maxSlots, 6);
  assert.equal(state.slots[0].booking?.round, 2);
});

test("public API requires a session and rejects impersonation, including old name/localStorage entry", async () => {
  const first = await planner.identifyWca({
    id: 900,
    name: "First Account",
    wcaId: null,
  });
  const second = await planner.identifyWca({
    id: 901,
    name: "Second Account",
    wcaId: null,
  });
  await planner.save(booking(second.id));
  const cookie = await createCompetitorSession(pool, first.id);
  const post = (body: unknown, auth = "") =>
    handle(
      new Request("https://example.test/api/planner", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: auth },
        body: JSON.stringify(body),
      }),
    );
  assert.equal(
    (await post({ action: "identify", name: "Second Account" })).status,
    401,
  );
  assert.equal(
    (await post({ action: "save", ...booking(second.id) })).status,
    401,
  );
  assert.equal(
    (await post({ action: "save", ...booking(second.id) }, cookie)).status,
    403,
  );
  assert.equal(
    (await post({ action: "remove", ...booking(second.id) }, cookie)).status,
    403,
  );
  assert.equal(
    (
      await post(
        { action: "save", ...booking(second.id), asAdmin: true },
        cookie,
      )
    ).status,
    401,
  );
  const publicState = await (
    await handle(
      new Request(`https://example.test/api/planner?competitorId=${second.id}`),
    )
  ).json();
  assert.equal(publicState.competitor, null);
  const personal = await (
    await handle(
      new Request(
        `https://example.test/api/planner?competitorId=${second.id}`,
        { headers: { cookie } },
      ),
    )
  ).json();
  assert.equal(personal.competitor.id, first.id);
  assert.equal(personal.slots[0].booking, null);
  assert.equal(
    (await post({ action: "save", slotId: "slot-b", eventId: "222" }, cookie))
      .status,
    200,
  );
  assert.equal(
    (await post({ action: "competitorLogout" }, cookie)).status,
    200,
  );
  assert.equal(
    (await post({ action: "remove", slotId: "slot-b" }, cookie)).status,
    401,
  );
  assert.equal(
    (await planner.state(second.id)).slots[0].booking?.competitorId,
    second.id,
  );
});
test("WCA linking preserves identifier-matched bookings, supports newcomers, and never claims by name", async () => {
  const old = await planner.identify("Same Name");
  await planner.save(booking(old.id));
  const fresh = await planner.identifyWca({
    id: 700,
    name: "Same Name",
    wcaId: null,
  });
  assert.notEqual(fresh.id, old.id);
  assert.equal((await planner.state(fresh.id)).slots[0].booking, null);
  const renamed = await planner.identifyWca({
    id: 700,
    name: "Corrected Name",
    wcaId: "2026TEST02",
  });
  assert.equal(renamed.id, fresh.id);
  assert.equal(renamed.name, "Corrected Name");
  await planner.importRoster([{ name: "New Competitor", wcaUserId: 701 }]);
  const imported = await pool.query(
    "SELECT id FROM planner.competitors WHERE wca_user_id=701",
  );
  await planner.save(booking(imported.rows[0].id));
  assert.equal(
    (
      await planner.identifyWca({
        id: 701,
        name: "New Competitor",
        wcaId: null,
      })
    ).id,
    imported.rows[0].id,
  );
  await assert.rejects(
    planner.identifyWca({
      id: 702,
      name: "Different Account",
      wcaId: "2026TEST02",
    }),
    { code: "ACCOUNT_CONFLICT" },
  );
});
test("OAuth validates state, consumes it once, checks accepted registration, and issues a revocable session", async (t) => {
  const previous = {
    id: process.env.WCA_CLIENT_ID,
    secret: process.env.WCA_CLIENT_SECRET,
    uri: process.env.WCA_REDIRECT_URI,
  };
  process.env.WCA_CLIENT_ID = "test-client";
  process.env.WCA_CLIENT_SECRET = "test-client-secret";
  process.env.WCA_REDIRECT_URI =
    "https://example.test/api/planner?action=wcaCallback";
  t.after(() => {
    for (const [key, value] of [
      ["WCA_CLIENT_ID", previous.id],
      ["WCA_CLIENT_SECRET", previous.secret],
      ["WCA_REDIRECT_URI", previous.uri],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  });
  let accepted = true;
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        assert.equal(
          new URLSearchParams(String(init?.body)).get("client_secret"),
          "test-client-secret",
        );
        return Response.json({ access_token: "private-access-token" });
      }
      if (url.endsWith("/me")) {
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          "Bearer private-access-token",
        );
        return Response.json({
          me: { id: 800, name: "OAuth Person", wca_id: null },
        });
      }
      return Response.json({
        persons: [
          {
            wcaUserId: 800,
            registration: {
              status: accepted ? "accepted" : "pending",
              isCompeting: true,
            },
          },
        ],
      });
    },
  );
  const start = async () => {
    const response = await handle(
      new Request("https://example.test/api/planner?action=wcaLogin"),
    );
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get("location")!);
    assert.equal(target.origin, "https://www.worldcubeassociation.org");
    assert.equal(target.searchParams.get("scope"), "public");
    return {
      state: target.searchParams.get("state")!,
      cookie: response.headers.getSetCookie()[0],
    };
  };
  const callback = (
    state: string,
    cookie: string,
    extra = "code=example-code",
  ) =>
    handle(
      new Request(
        `https://example.test/api/planner?action=wcaCallback&state=${state}&${extra}`,
        { headers: { cookie } },
      ),
    );
  const first = await start();
  assert.match(
    (await callback(first.state, "")).headers.get("location")!,
    /invalid_state/,
  );
  assert.equal(calls, 0);
  const success = await callback(first.state, first.cookie);
  assert.equal(success.headers.get("location"), "/");
  const session = success.headers
    .getSetCookie()
    .find((c) => c.startsWith("ronda_competitor="))!;
  assert.match(session, /HttpOnly; SameSite=Lax/);
  const state = await (
    await handle(
      new Request("https://example.test/api/planner", {
        headers: { cookie: session },
      }),
    )
  ).json();
  assert.equal(state.competitor.name, "OAuth Person");
  const count = calls;
  assert.match(
    (await callback(first.state, first.cookie)).headers.get("location")!,
    /invalid_state/,
  );
  assert.equal(calls, count);
  const denied = await start();
  assert.match(
    (
      await callback(denied.state, denied.cookie, "error=access_denied")
    ).headers.get("location")!,
    /denied/,
  );
  accepted = false;
  const pending = await start();
  const rejected = await callback(pending.state, pending.cookie);
  assert.match(rejected.headers.get("location")!, /not_registered/);
  assert.equal(
    rejected.headers
      .getSetCookie()
      .some((c) => c.startsWith("ronda_competitor=")),
    false,
  );
  const expired = await start();
  await pool.query(
    "UPDATE planner.oauth_states SET expires_at=now()-interval '1 second'",
  );
  assert.match(
    (await callback(expired.state, expired.cookie)).headers.get("location")!,
    /invalid_state/,
  );
  await pool.query(
    "UPDATE planner.competitor_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [digest(cookieValue(session, "ronda_competitor")!)],
  );
  assert.equal(
    (
      await (
        await handle(
          new Request("https://example.test/api/planner", {
            headers: { cookie: session },
          }),
        )
      ).json()
    ).competitor,
    null,
  );
});
