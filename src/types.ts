import type { Booking, CompetitionEvent } from "./domain.js";
export interface Competitor {
  id: string;
  name: string;
  wcaId: string | null;
}
export interface SlotView {
  id: string;
  label: string;
  startsAt: string;
  capacity: number;
  occupancy: number;
  booking: Booking | null;
}
export interface PlannerState {
  events: CompetitionEvent[];
  slots: SlotView[];
  competitor: Competitor | null;
  locked: boolean;
  maxSlots: number;
  wcaLoginAvailable?: boolean;
}
export interface AdminState extends PlannerState {
  competitors: Competitor[];
  bookings: Booking[];
}
