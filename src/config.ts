// Verified against the public WCA WCIF on 2026-09-21. Times use Buenos Aires UTC−3.
export const competition = {
  id: "ElegiTuRondaBA2026",
  name: "Elegí Tu Ronda",
  location: "Buenos Aires",
  date: "2026-10-24",
  dateLabel: "Sábado 24 de octubre de 2026",
  timezone: "America/Argentina/Buenos_Aires",
  venue: "Casa del Bicentenario",
  stations: 6,
  solvingMinutes: 20,
  url: "https://www.worldcubeassociation.org/competitions/ElegiTuRondaBA2026",
};
import type { CompetitionEvent } from "./domain.js";
export const seedEvents: CompetitionEvent[] = [
  { id: "222", name: "2x2x2", label: "2x2", rounds: [1, 2] },
  { id: "666", name: "6x6x6", label: "6x6", rounds: [1, 2] },
  { id: "777", name: "7x7x7", label: "7x7", rounds: [1, 2] },
  { id: "333bf", name: "3x3x3 Blindfolded", label: "3BLD", rounds: [1, 2] },
  { id: "pyram", name: "Pyraminx", label: "Pyr", rounds: [1, 2] },
  { id: "sq1", name: "Square-1", label: "Sq-1", rounds: [1, 2] },
  { id: "444bf", name: "4x4x4 Blindfolded", label: "4BLD", rounds: [1, 2] },
  { id: "555bf", name: "5x5x5 Blindfolded", label: "5BLD", rounds: [1, 2] },
  {
    id: "fto",
    name: "Face-Turning Octahedron (extraoficial)",
    label: "FTO",
    rounds: [1],
  },
];
export const seedSlots = [
  "15:30",
  "16:00",
  "16:30",
  "17:00",
  "17:30",
  "18:00",
  "18:30",
  "19:00",
].map((time, index) => ({
  id: `slot-${String.fromCharCode(97 + index)}`,
  label: `Slot ${String.fromCharCode(65 + index)}`,
  startsAt: `${competition.date}T${time}:00-03:00`,
  capacity: 10,
}));
