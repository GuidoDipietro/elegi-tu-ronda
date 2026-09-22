import { competition } from "./config.ts";
import type { AdminState } from "./types.ts";
export function timeLabel(date: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: competition.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(date));
}
export function csvCell(value: string): string {
  const safe =
    /^[\s]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function scheduleCsv(state: AdminState): string {
  const rows = [
    [
      "Competidor",
      "WCA ID",
      ...state.slots.map((slot) => timeLabel(slot.startsAt)),
    ],
    ...state.competitors.map((person) => [
      person.name,
      person.wcaId || "",
      ...state.slots.map((slot) => {
        const booking = state.bookings.find(
          (b) => b.competitorId === person.id && b.slotId === slot.id,
        );
        return booking
          ? `${state.events.find((e) => e.id === booking.eventId)?.label || booking.eventId}`
          : "";
      }),
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
