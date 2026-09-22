export type Round = 1 | 2;
export interface CompetitionEvent {
  id: string;
  name: string;
  label: string;
  rounds: readonly Round[];
}
export interface Slot {
  id: string;
  startsAt: string;
  capacity: number;
}
export interface Booking {
  competitorId: string;
  slotId: string;
  eventId: string;
  round: Round;
}

export class BookingError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Invoke inside the same database transaction that locks the Slot and saves the booking. */
export function validateBooking(input: {
  eventId: unknown;
  round: unknown;
  events: readonly CompetitionEvent[];
  capacity: number;
  occupancy: number;
  existingBooking: boolean;
}): { eventId: string; round: Round } {
  if (
    typeof input.eventId !== "string" ||
    !input.events.some((event) => event.id === input.eventId)
  ) {
    throw new BookingError("INVALID_EVENT", "Elegí un evento válido.");
  }
  if (
    (input.round !== 1 && input.round !== 2) ||
    !input.events
      .find((event) => event.id === input.eventId)!
      .rounds.includes(input.round)
  ) {
    throw new BookingError(
      "INVALID_ROUND",
      "Elegí una ronda disponible para este evento.",
    );
  }
  // An existing competitor keeps their place when editing a full Slot.
  if (!input.existingBooking && input.occupancy >= input.capacity) {
    throw new BookingError(
      "SLOT_FULL",
      "Este Slot ya está completo. Elegí otro.",
    );
  }
  return { eventId: input.eventId, round: input.round };
}

export function validateCapacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BookingError(
      "INVALID_CAPACITY",
      "La capacidad debe ser un número entero mayor o igual a cero.",
    );
  }
  return value;
}

export function normalizeName(value: unknown): { name: string; key: string } {
  if (typeof value !== "string")
    throw new BookingError("INVALID_NAME", "Ingresá tu nombre y apellido.");
  const name = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new BookingError(
      "INVALID_NAME",
      "Usá un nombre de entre 2 y 100 caracteres.",
    );
  }
  return {
    name,
    key: name
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase("es-AR"),
  };
}
export function requireId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new BookingError(
      "INVALID_PERSON",
      "No pudimos identificar al competidor. Actualizá la página e intentá de nuevo.",
    );
  }
  return value;
}
