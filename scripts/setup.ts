import { readFile } from "node:fs/promises";
import { database } from "../src/server/db.ts";
import { seedEvents, seedSlots } from "../src/config.ts";
const pool = database();
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(
    await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"),
  );
  for (const [position, event] of seedEvents.entries()) {
    await client.query(
      "INSERT INTO planner.events(id, name, label, position, rounds) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, label=EXCLUDED.label, position=EXCLUDED.position, rounds=EXCLUDED.rounds",
      [event.id, event.name, event.label, position, event.rounds],
    );
  }
  for (const slot of seedSlots) {
    // Re-running setup must never overwrite an organizer's capacity changes.
    await client.query(
      "INSERT INTO planner.slots(id, label, starts_at, capacity) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
      [slot.id, slot.label, slot.startsAt, slot.capacity],
    );
  }
  await client.query("COMMIT");
  console.log(
    "Database ready: events and Slots seeded. No demo competitors added.",
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
