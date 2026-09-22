import { readFile } from "node:fs/promises";
import { competition } from "../src/config.ts";
import { database } from "../src/server/db.ts";
import { Planner } from "../src/server/service.ts";
const pool = database();
try {
  const file = process.argv[2];
  let records;
  if (file) records = JSON.parse(await readFile(file, "utf8"));
  else {
    const response = await fetch(
      `https://www.worldcubeassociation.org/api/v0/competitions/${competition.id}/wcif/public`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(`WCA returned ${response.status}`);
    const wcif = await response.json();
    records = wcif.persons
      .filter(
        (p: { registration?: { status?: string; isCompeting?: boolean } }) =>
          p.registration?.status === "accepted" &&
          p.registration?.isCompeting !== false,
      )
      .map((p: { name: string; wcaId?: string; wcaUserId?: number }) => ({
        name: p.name,
        wcaId: p.wcaId,
        wcaUserId: p.wcaUserId,
      }));
  }
  console.log(
    `Imported ${await new Planner(pool).importRoster(records)} competitors. Existing bookings preserved.`,
  );
} finally {
  await pool.end();
}
