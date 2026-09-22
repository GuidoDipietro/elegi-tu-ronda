import type { WcaProfile } from "./wca-auth.js";
import type { Pool, PoolClient } from "pg";
import {
  BookingError,
  normalizeName,
  requireId,
  validateBooking,
  validateCapacity,
} from "../domain.js";
import type { AdminState, Competitor, PlannerState } from "../types.js";

export class Planner {
  constructor(private pool: Pool) {}
  private async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async identify(value: unknown): Promise<Competitor> {
    const { name, key } = normalizeName(value);
    const byWca = await this.pool.query(
      'SELECT id, name, wca_id AS "wcaId" FROM planner.competitors WHERE wca_id=$1',
      [name.toUpperCase()],
    );
    if (byWca.rows[0]) return byWca.rows[0];
    const people = await this.pool.query(
      'SELECT id,name,wca_id AS "wcaId" FROM planner.competitors',
    );
    const matching = people.rows.filter(
      (person) => normalizeName(person.name).key === key,
    );
    if (matching.length > 1)
      throw new BookingError(
        "AMBIGUOUS_NAME",
        "Hay varias personas con ese nombre. Elegí su fila en la tabla o usá el WCA ID.",
      );
    if (matching[0]) return matching[0];
    // Upsert returns the existing identity without renaming it or erasing WCA metadata.
    const result = await this.pool.query(
      `INSERT INTO planner.competitors(name, name_key) VALUES ($1,$2)
      ON CONFLICT(name_key) DO UPDATE SET name_key=EXCLUDED.name_key RETURNING id, name, wca_id AS "wcaId"`,
      [name, key],
    );
    return result.rows[0];
  }
  async identifyWca(profile: WcaProfile): Promise<Competitor> {
    const { name } = normalizeName(profile.name);
    return this.transaction(async (client) => {
      // Serialize account linking with roster imports. Never claim bookings by name.
      await client.query("SELECT pg_advisory_xact_lock(72814320)");
      const existing = await client.query(
        "SELECT id, wca_user_id FROM planner.competitors WHERE wca_user_id=$1 OR ($2::text IS NOT NULL AND wca_id=$2) FOR UPDATE",
        [profile.id, profile.wcaId],
      );
      if (
        existing.rowCount! > 1 ||
        (existing.rows[0]?.wca_user_id &&
          String(existing.rows[0].wca_user_id) !== String(profile.id))
      )
        throw new BookingError(
          "ACCOUNT_CONFLICT",
          "La organización tiene que revisar la vinculación con tu cuenta de la WCA.",
        );
      const result = existing.rows[0]
        ? await client.query(
            'UPDATE planner.competitors SET name=$1,wca_user_id=$2,wca_id=$3 WHERE id=$4 RETURNING id,name,wca_id AS "wcaId"',
            [name, profile.id, profile.wcaId, existing.rows[0].id],
          )
        : await client.query(
            'INSERT INTO planner.competitors(name,name_key,wca_user_id,wca_id) VALUES ($1,$2,$3,$4) RETURNING id,name,wca_id AS "wcaId"',
            [name, `wca:${profile.id}`, profile.id, profile.wcaId],
          );
      return result.rows[0];
    });
  }
  async state(
    competitorId: string | null,
    admin = false,
  ): Promise<PlannerState | AdminState> {
    if (competitorId) requireId(competitorId);
    // One SQL statement gives occupancy and personal bookings a consistent snapshot.
    const result = await this.pool.query(
      `SELECT json_build_object(
      'events', (SELECT coalesce(json_agg(e ORDER BY position), '[]') FROM planner.events e),
      'locked', (SELECT locked FROM planner.settings WHERE id=true),
      'maxSlots', (SELECT max_slots FROM planner.settings WHERE id=true),
      'competitor', (SELECT json_build_object('id',id,'name',name,'wcaId',wca_id) FROM planner.competitors WHERE id=$1),
      'slots', (SELECT coalesce(json_agg(s ORDER BY s."startsAt"), '[]') FROM (
        SELECT id, label, starts_at AS "startsAt", capacity,
        (SELECT count(*)::int FROM planner.bookings WHERE slot_id=slots.id) AS occupancy,
        (SELECT json_build_object('competitorId',competitor_id,'slotId',slot_id,'eventId',event_id,'round',round)
          FROM planner.bookings WHERE slot_id=slots.id AND competitor_id=$1) AS booking
        FROM planner.slots) s),
      'competitors', CASE WHEN $2 THEN (SELECT coalesce(json_agg(json_build_object('id',id,'name',name,'wcaId',wca_id) ORDER BY name), '[]') FROM planner.competitors) ELSE '[]'::json END,
      'bookings', CASE WHEN $2 THEN (SELECT coalesce(json_agg(json_build_object('competitorId',competitor_id,'slotId',slot_id,'eventId',event_id,'round',round)), '[]') FROM planner.bookings) ELSE '[]'::json END
      ) AS state`,
      [competitorId, admin],
    );
    return result.rows[0].state;
  }
  async save(input: Record<string, unknown>, admin = false): Promise<void> {
    const competitorId = requireId(input.competitorId);
    if (typeof input.slotId !== "string")
      throw new BookingError("INVALID_SLOT", "Elegí un Slot válido.");
    await this.transaction(async (client) => {
      const settings = await client.query(
        "SELECT locked FROM planner.settings WHERE id=true FOR SHARE",
      );
      if (settings.rows[0].locked && !admin)
        throw new BookingError("LOCKED", "Las reservas están cerradas.");
      const person = await client.query(
        "SELECT id FROM planner.competitors WHERE id=$1 FOR UPDATE",
        [competitorId],
      );
      if (!person.rowCount)
        throw new BookingError(
          "INVALID_PERSON",
          "No pudimos identificar al competidor. Actualizá la página e intentá de nuevo.",
        );
      const slot = await client.query(
        "SELECT capacity FROM planner.slots WHERE id=$1 FOR UPDATE",
        [input.slotId],
      );
      if (!slot.rowCount)
        throw new BookingError(
          "INVALID_SLOT",
          "Este Slot ya no existe. Actualizá la página.",
        );
      const existing = await client.query(
        "SELECT competitor_id FROM planner.bookings WHERE slot_id=$1",
        [input.slotId],
      );
      const events = await client.query(
        "SELECT id, name, label, rounds FROM planner.events",
      );
      const booking = validateBooking({
        eventId: input.eventId,
        round: input.round ?? 1,
        events: events.rows,
        capacity: slot.rows[0].capacity,
        occupancy: existing.rowCount!,
        existingBooking: existing.rows.some(
          (row) => row.competitor_id === competitorId,
        ),
      });
      await client.query(
        `INSERT INTO planner.bookings(competitor_id,slot_id,event_id,round) VALUES ($1,$2,$3,$4)
        ON CONFLICT(competitor_id,slot_id) DO UPDATE SET event_id=EXCLUDED.event_id, round=EXCLUDED.round`,
        [competitorId, input.slotId, booking.eventId, booking.round],
      );
    });
  }
  async remove(input: Record<string, unknown>, admin = false): Promise<void> {
    const competitorId = requireId(input.competitorId);
    if (typeof input.slotId !== "string")
      throw new BookingError("INVALID_SLOT", "Elegí un Slot válido.");
    await this.transaction(async (client) => {
      const settings = await client.query(
        "SELECT locked FROM planner.settings WHERE id=true FOR SHARE",
      );
      if (settings.rows[0].locked && !admin)
        throw new BookingError("LOCKED", "Las reservas están cerradas.");
      await client.query(
        "SELECT id FROM planner.competitors WHERE id=$1 FOR UPDATE",
        [competitorId],
      );
      await client.query(
        "SELECT id FROM planner.slots WHERE id=$1 FOR UPDATE",
        [input.slotId],
      );
      await client.query(
        "DELETE FROM planner.bookings WHERE competitor_id=$1 AND slot_id=$2",
        [competitorId, input.slotId],
      );
    });
  }
  async capacity(slotId: unknown, value: unknown): Promise<void> {
    const capacity = validateCapacity(value);
    if (capacity > 2147483647)
      throw new BookingError(
        "INVALID_CAPACITY",
        "La capacidad es demasiado grande.",
      );
    if (typeof slotId !== "string")
      throw new BookingError("INVALID_SLOT", "Elegí un Slot válido.");
    const result = await this.pool.query(
      "UPDATE planner.slots SET capacity=$1 WHERE id=$2",
      [capacity, slotId],
    );
    if (!result.rowCount)
      throw new BookingError("INVALID_SLOT", "Este Slot ya no existe.");
  }
  async limit(value: unknown): Promise<void> {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 2147483647
    )
      throw new BookingError(
        "INVALID_LIMIT",
        "El límite debe ser un número entero mayor o igual a cero (hasta 2147483647).",
      );
    await this.pool.query(
      "UPDATE planner.settings SET max_slots=$1 WHERE id=true",
      [value],
    );
  }
  async lock(value: unknown): Promise<void> {
    if (typeof value !== "boolean")
      throw new BookingError("INVALID_LOCK", "Estado inválido.");
    await this.pool.query(
      "UPDATE planner.settings SET locked=$1 WHERE id=true",
      [value],
    );
  }
  async importRoster(records: unknown): Promise<number> {
    if (!Array.isArray(records) || records.length > 1000)
      throw new BookingError(
        "INVALID_ROSTER",
        "Usá un archivo JSON con hasta 1000 competidores.",
      );
    const roster = records.map((row) => {
      const { name, key } = normalizeName(row?.name);
      const wcaId = row.wcaId ? String(row.wcaId).toUpperCase() : null;
      if (wcaId && !/^[0-9]{4}[A-Z]{4}[0-9]{2}$/.test(wcaId))
        throw new BookingError("INVALID_ROSTER", `WCA ID inválido: ${wcaId}`);
      const wcaUserId = row.wcaUserId ?? null;
      if (
        wcaUserId !== null &&
        (!Number.isSafeInteger(wcaUserId) || wcaUserId <= 0)
      )
        throw new BookingError(
          "INVALID_ROSTER",
          "El identificador de la cuenta de la WCA no es válido.",
        );
      return { name, key, wcaId, wcaUserId };
    });
    if (new Set(roster.map((r) => r.key)).size !== roster.length)
      throw new BookingError(
        "INVALID_ROSTER",
        "Hay nombres duplicados. Agregá una inicial para distinguirlos.",
      );
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(72814320)");
      for (const person of roster) {
        const existing = await client.query(
          "SELECT id,wca_id,wca_user_id FROM planner.competitors WHERE ($1::text IS NOT NULL AND wca_id=$1) OR ($2::bigint IS NOT NULL AND wca_user_id=$2)",
          [person.wcaId, person.wcaUserId],
        );
        if (existing.rowCount! > 1)
          throw new BookingError(
            "INVALID_ROSTER",
            "Hay cuentas de la WCA vinculadas a distintas personas. Revisá las vinculaciones.",
          );
        if (existing.rowCount) {
          const linked = existing.rows[0];
          if (
            (person.wcaUserId &&
              linked.wca_user_id &&
              String(linked.wca_user_id) !== String(person.wcaUserId)) ||
            (person.wcaId && linked.wca_id && linked.wca_id !== person.wcaId)
          )
            throw new BookingError(
              "INVALID_ROSTER",
              "La cuenta de la WCA no coincide con la que ya está vinculada.",
            );
          await client.query(
            "UPDATE planner.competitors SET wca_user_id=coalesce(wca_user_id,$1),wca_id=coalesce(wca_id,$2) WHERE id=$3",
            [person.wcaUserId, person.wcaId, existing.rows[0].id],
          );
          continue;
        }
        await client.query(
          `INSERT INTO planner.competitors(name,name_key,wca_id,wca_user_id) VALUES ($1,$2,$3,$4)
          ON CONFLICT(name_key) DO NOTHING`,
          [
            person.name,
            person.wcaUserId
              ? `wca:${person.wcaUserId}`
              : person.wcaId
                ? `roster:${person.wcaId}`
                : person.key,
            person.wcaId,
            person.wcaUserId,
          ],
        );
      }
    });
    return roster.length;
  }
}
