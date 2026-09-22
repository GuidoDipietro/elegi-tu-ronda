import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, storedPerson, storePerson } from "./client.ts";
import { competition } from "./config.ts";
import { scheduleCsv, timeLabel } from "./format.ts";
import type { Booking, CompetitionEvent } from "./domain.ts";
import type {
  AdminState,
  Competitor,
  PlannerState,
  SlotView,
} from "./types.ts";
import "./style.css";

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
function Header({ admin }: { admin: boolean }) {
  return (
    <header className="header">
      <a className="brand" href="/">
        <Mark />
        <span>
          {competition.name}
          <small>
            {competition.location.toUpperCase()} ·{" "}
            {competition.date.slice(0, 4)}
          </small>
        </span>
      </a>
      <a className="header-link" href={admin ? "/" : "/admin"}>
        {admin ? "Ver Slots ↗" : "Organización ↗"}
      </a>
    </header>
  );
}
function Notice({
  message,
  error = false,
}: {
  message: string;
  error?: boolean;
}) {
  return message ? (
    <div
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {message}
    </div>
  ) : null;
}
function Identity({
  onIdentify,
  busy,
  compact = false,
}: {
  onIdentify: (name: string) => Promise<void>;
  busy: boolean;
  compact?: boolean;
}) {
  const [name, setName] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) await onIdentify(name);
  }
  return (
    <form className={`identity ${compact ? "compact" : ""}`} onSubmit={submit}>
      {!compact && (
        <div>
          <span className="eyebrow">PRIMERO, VOS</span>
          <h2>¿Cómo te llamás?</h2>
          <p>Usá siempre el mismo nombre para recuperar tu horario.</p>
        </div>
      )}
      <div className="identity-fields">
        <label>
          Nombre y apellido o WCA ID
          <input
            name="name"
            autoComplete="name"
            minLength={2}
            maxLength={100}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Por ejemplo, Alex García"
            disabled={busy}
          />
        </label>
        <button className="primary" disabled={busy || name.trim().length < 2}>
          {busy
            ? "Un momento…"
            : compact
              ? "Ver / agregar"
              : "Elegir mis Slots →"}
        </button>
      </div>
      {!compact && (
        <small>
          No necesitás una cuenta. El horario se edita por nombre, sin
          contraseña.
        </small>
      )}
    </form>
  );
}
function SlotCard({
  slot,
  events,
  enabled,
  locked,
  busy,
  onSave,
  onRemove,
  continuation = false,
  limitReached = false,
}: {
  slot: SlotView;
  events: CompetitionEvent[];
  enabled: boolean;
  locked: boolean;
  busy: boolean;
  onSave: (slotId: string, eventId: string) => Promise<boolean>;
  onRemove: (slotId: string) => Promise<boolean>;
  continuation?: boolean;
  limitReached?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [eventId, setEventId] = useState("");
  const booking = slot.booking;
  const full = slot.occupancy >= slot.capacity;
  const over = slot.occupancy > slot.capacity;
  const selected = events.find((event) => event.id === eventId);
  const bookedEvent = events.find((event) => event.id === booking?.eventId);
  const percent = slot.capacity
    ? Math.min(100, (slot.occupancy / slot.capacity) * 100)
    : 100;
  function edit() {
    setEventId(booking?.eventId || "");
    setEditing(true);
    setRemoving(false);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (eventId && (await onSave(slot.id, eventId))) setEditing(false);
  }
  return (
    <article
      className={`slot ${booking ? "mine" : ""} ${full && !booking ? "full" : ""}`}
    >
      <div className="slot-top">
        <div className="slot-time">
          <span className="eyebrow">{slot.label}</span>
          <h3>
            {timeLabel(slot.startsAt)}
            <span>
              –{" "}
              {timeLabel(
                new Date(
                  new Date(slot.startsAt).getTime() +
                    competition.solvingMinutes * 60_000,
                ).toISOString(),
              )}
            </span>
          </h3>
        </div>
        <span className={`badge ${booking ? "green" : full ? "warm" : ""}`}>
          {booking
            ? "Tu lugar ✓"
            : over
              ? "Sobreocupado"
              : full
                ? "Completo"
                : `${slot.capacity - slot.occupancy} ${slot.capacity - slot.occupancy === 1 ? "libre" : "libres"}`}
        </span>
      </div>
      <div className="occupancy">
        <span>
          {slot.occupancy} / {slot.capacity} lugares
        </span>
        <span>
          {over
            ? `${slot.occupancy - slot.capacity} sobre el cupo`
            : slot.occupancy >= slot.capacity * 0.8 && !full
              ? "Se está llenando"
              : "20 min para competir"}
        </span>
      </div>
      <div
        className="meter"
        role="meter"
        aria-label={`Ocupación de ${slot.label}`}
        aria-valuemin={0}
        aria-valuemax={Math.max(slot.capacity, slot.occupancy, 1)}
        aria-valuenow={slot.occupancy}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      {editing && enabled ? (
        <form className="booking-form" onSubmit={submit}>
          <label>
            Evento
            <select
              value={eventId}
              required
              disabled={busy || locked}
              onChange={(e) => setEventId(e.target.value)}
            >
              <option value="">Elegí un evento…</option>
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name}
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button
              className="primary"
              disabled={busy || locked || !selected || (!booking && (full || limitReached))}
            >
              {busy ? "Guardando…" : "Guardar lugar"}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancelar
            </button>
          </div>
        </form>
      ) : booking ? (
        <div className="booking">
          <div>
            <strong>
              {bookedEvent?.label || booking.eventId}
            </strong>
            {continuation && <small>También en otro Slot</small>}
          </div>
          <button
            className="quiet"
            disabled={busy || locked || !enabled}
            onClick={edit}
          >
            Cambiar
          </button>
        </div>
      ) : (
        <button
          className="choose"
          onClick={edit}
          disabled={busy || locked || !enabled || full || limitReached}
        >
          {full
            ? "Completo"
            : locked
              ? "Reservas cerradas"
              : !enabled
                ? "Ingresá tu nombre para elegir"
                : limitReached ? "Límite de Slots alcanzado" : "＋ Elegir evento"}
        </button>
      )}
      {booking && !editing && enabled && !locked && (
        <div className="remove-line">
          {removing ? (
            <>
              <span>¿Liberar este lugar?</span>
              <button
                className="danger-text"
                disabled={busy}
                onClick={async () => {
                  if (await onRemove(slot.id)) setRemoving(false);
                }}
              >
                Sí, liberar
              </button>
              <button
                className="quiet"
                disabled={busy}
                onClick={() => setRemoving(false)}
              >
                Volver
              </button>
            </>
          ) : (
            <button
              className="remove-button"
              disabled={busy}
              onClick={() => setRemoving(true)}
            >
              Liberar lugar
            </button>
          )}
        </div>
      )}
    </article>
  );
}
function LimitForm({ value, busy, onSave }: { value: number; busy: boolean; onSave: (value: number) => Promise<boolean> }) {
  const [limit, setLimit] = useState(String(value));
  return <form className="identity-fields" onSubmit={(e) => { e.preventDefault(); void onSave(Number(limit)); }}>
    <label>Máximo de Slots por competidor<input type="number" min="0" max="2147483647" step="1" required value={limit} disabled={busy} onChange={(e) => setLimit(e.target.value)} /></label>
    <button className="primary" disabled={busy || limit === "" || Number(limit) === value}>Guardar límite</button>
  </form>;
}
function App() {
  const adminPage =
    location.pathname === "/admin" || location.pathname === "/admin/";
  const [personId, setPersonId] = useState(storedPerson);
  const [state, setState] = useState<PlannerState | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const load = useCallback(async () => {
    const request = ++revision.current;
    try {
      const next = await api<PlannerState>(
        personId ? `?competitorId=${encodeURIComponent(personId)}` : "",
      );
      if (request !== revision.current) return;
      setState(next);
      if (personId && !next.competitor) {
        storePerson("");
        setPersonId("");
      }
      setError("");
    } catch (e) {
      if (request === revision.current) setError((e as Error).message);
    }
  }, [personId]);
  useEffect(() => {
    if (adminPage) return;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    const focus = () => {
      void load();
    };
    window.addEventListener("focus", focus);
    return () => {
      ++revision.current;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [adminPage, load]);
  async function identify(name: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const person = await api<Competitor>("", { action: "identify", name });
      storePerson(person.id);
      setPersonId(person.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mutate(
    action: string,
    slotId: string,
    eventId?: string,
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("", { action, competitorId: personId, slotId, eventId });
      await load();
      setMessage(
        action === "save"
          ? "Listo, tu lugar está guardado."
          : "Liberaste tu lugar.",
      );
      return true;
    } catch (e) {
      await load();
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const bookings = state?.slots.filter((slot) => slot.booking) || [];
  return (
    <>
      <Header admin={adminPage} />
      {adminPage ? (
        <Admin />
      ) : (
        <main>
          <section className={`hero ${state?.competitor ? "returning" : ""}`}>
            <div className="date-pill">
              <span />
              {new Intl.DateTimeFormat("es-AR", {
                day: "numeric",
                month: "long",
                timeZone: competition.timezone,
              })
                .format(new Date(competition.date + "T12:00:00-03:00"))
                .toUpperCase()}{" "}
              · {competition.venue.toUpperCase()}
            </div>
            <h1>
              {state?.competitor ? (
                <>
                  Tus Slots, <span>a tu ritmo.</span>
                </>
              ) : (
                <>
                  Tu ritmo.
                  <br />
                  Tu ronda. <span>Tu Slot.</span>
                </>
              )}
            </h1>
            <p>
              Armá tu horario para competir. Elegí un lugar y un evento.
              La ronda se define el día de la competencia. Lo podés cambiar después.
            </p>
            <div className="facts">
              <span>◷ 20 min por Slot</span>
              <span>▦ {competition.stations} estaciones</span>
              <span>↔ Podés repetir un evento</span>
            </div>
          </section>
          <Notice message={error} error />
          {error && (
            <button
              className="quiet"
              disabled={busy}
              onClick={() => void load()}
            >
              Reintentar conexión
            </button>
          )}
          <Notice message={message} />
          {state && !state.competitor && (
            <Identity onIdentify={identify} busy={busy} />
          )}
          {state?.competitor && (
            <section className="person-bar">
              <div>
                <span className="eyebrow">ESTÁS ARMANDO EL HORARIO DE</span>
                <h2>{state.competitor.name}</h2>
              </div>
              <button
                className="quiet"
                disabled={busy}
                onClick={() => {
                  storePerson("");
                  setPersonId("");
                  setState(null);
                  setMessage("");
                }}
              >
                Cambiar persona
              </button>
            </section>
          )}
          {state?.competitor && <Notice message={`Podés elegir hasta ${Math.max(0, state.maxSlots - bookings.length)} Slots garantizados más. Límite actual: ${state.maxSlots} por persona. Organización habilitará más lugares por etapas.`} />}
          {state?.locked && (
            <Notice message="Las reservas están cerradas. Podés consultar tu horario; para cambiarlo, hablá con organización." />
          )}
          {bookings.length > 0 && (
            <section className="my-schedule">
              <span className="eyebrow">
                MI HORARIO · {bookings.length}{" "}
                {bookings.length === 1 ? "SLOT" : "SLOTS"}
              </span>
              <div>
                {bookings.map((slot) => (
                  <a key={slot.id} href={`#${slot.id}`}>
                    <b>{timeLabel(slot.startsAt)}</b>{" "}
                    {
                      state?.events.find((e) => e.id === slot.booking?.eventId)
                        ?.label
                    }
                  </a>
                ))}
              </div>
            </section>
          )}
          <section className="timeline-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">
                  {competition.dateLabel.toUpperCase()}
                </span>
                <h2>Elegí tu Slot</h2>
              </div>
              <span className="live">
                <i />
                Cupos actualizados cada 15 s
              </span>
            </div>
            {!state ? (
              <div className="loading" role="status">
                {error
                  ? "Todavía no pudimos cargar los Slots."
                  : "Cargando Slots…"}
              </div>
            ) : (
              <div className="slots">
                {state.slots.map((slot) => (
                  <div id={slot.id} key={`${personId}-${slot.id}`}>
                    <SlotCard
                      slot={slot}
                      events={state.events}
                      enabled={!!state.competitor}
                      locked={state.locked}
                      busy={busy}
                      limitReached={bookings.length >= state.maxSlots}
                      onSave={(id, event) =>
                        mutate("save", id, event)
                      }
                      onRemove={(id) => mutate("remove", id)}
                      continuation={
                        !!slot.booking &&
                        bookings.some(
                          (other) =>
                            other.id !== slot.id &&
                            other.booking?.eventId === slot.booking?.eventId,
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
          <aside className="how-it-works">
            <span aria-hidden="true">↳</span>
            <div>
              <h3>¿Necesitás más tiempo?</h3>
              <p>
                Podés elegir el mismo evento y ronda en varios Slots para
                continuar. En cada Slot, reservá un solo evento. El día de la competencia se define si continuás una ronda o empezás la siguiente.
              </p>
            </div>
          </aside>
        </main>
      )}
      <footer>
        <span>
          {competition.name} · {competition.location}{" "}
          {competition.date.slice(0, 4)}
        </span>
        <a href={competition.url} target="_blank" rel="noreferrer">
          Información de la competencia ↗
        </a>
      </footer>
    </>
  );
}

function CapacityForm({
  slot,
  busy,
  onSave,
}: {
  slot: SlotView;
  busy: boolean;
  onSave: (id: string, capacity: number) => Promise<boolean>;
}) {
  const [value, setValue] = useState(String(slot.capacity));
  useEffect(() => setValue(String(slot.capacity)), [slot.capacity]);
  return (
    <form
      className={`capacity-card ${slot.occupancy > slot.capacity ? "over" : ""}`}
      onSubmit={async (e) => {
        e.preventDefault();
        await onSave(slot.id, Number(value));
      }}
    >
      <div>
        <strong>
          {slot.label} · {timeLabel(slot.startsAt)}
        </strong>
        <span>
          {slot.occupancy} / {slot.capacity} lugares
          {slot.occupancy > slot.capacity
            ? " · Sobreocupado"
            : slot.occupancy >= slot.capacity
              ? " · Completo"
              : slot.occupancy >= slot.capacity * 0.8
                ? " · Casi completo"
                : ""}
        </span>
      </div>
      <label>
        Cupo
        <input
          type="number"
          min="0"
          max="2147483647"
          step="1"
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          aria-label={`Capacidad de ${slot.label}`}
        />
      </label>
      <button
        disabled={busy || value === "" || Number(value) === slot.capacity}
      >
        Guardar
      </button>
    </form>
  );
}
function Admin() {
  const [state, setState] = useState<AdminState | null>(null);
  const [login, setLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const revision = ++requestId.current;
    try {
      const next = await api<AdminState>("?action=admin");
      if (revision === requestId.current) {
        setState(next);
        setLogin(false);
      }
    } catch (e) {
      if (revision !== requestId.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setLogin(true);
        setState(null);
      } else setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => {
      ++requestId.current;
      clearInterval(timer);
    };
  }, [load]);
  async function action(
    body: Record<string, unknown>,
    success = "Cambios guardados.",
  ): Promise<boolean> {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("", { ...body, asAdmin: true });
      await load();
      setMessage(success);
      return true;
    } catch (e) {
      await load();
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function signIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("", { action: "login", password });
      setPassword("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function identify(name: string) {
    setBusy(true);
    setError("");
    try {
      const person = await api<Competitor>("", { action: "identify", name });
      setSelected(person.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function exportCsv() {
    if (!state) return;
    const url = URL.createObjectURL(
      new Blob([scheduleCsv(state)], { type: "text/csv;charset=utf-8;" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "elegi-tu-ronda-horarios.csv";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const person = state?.competitors.find((p) => p.id === selected);
  const selectedSlots =
    state?.slots.map((slot) => ({
      ...slot,
      booking:
        state.bookings.find(
          (b) => b.slotId === slot.id && b.competitorId === selected,
        ) || null,
    })) || [];
  const label = (booking?: Booking) =>
    booking
      ? `${state?.events.find((event) => event.id === booking.eventId)?.label || booking.eventId}`
      : "—";
  return (
    <main className="admin">
      <section className="admin-title">
        <span className="eyebrow">ORGANIZACIÓN</span>
        <h1>La ronda, de un vistazo.</h1>
        <p>Distribuí los lugares y encontrá el horario de cada competidor.</p>
      </section>
      <Notice message={error} error />
      <Notice message={message} />
      {login ? (
        <form className="login-panel" onSubmit={signIn}>
          <h2>Acceso de organización</h2>
          <label>
            Contraseña
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={busy}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      ) : !state ? (
        <div className="loading">
          <p>Cargando organización…</p>
          {error && <button onClick={() => void load()}>Reintentar</button>}
        </div>
      ) : (
        <>
          <div className="admin-toolbar">
            <div className="stats">
              <b>{state.competitors.length}</b> personas <span>·</span>{" "}
              <b>{state.bookings.length}</b> reservas
            </div>
            <div className="actions">
              <button disabled={busy} onClick={exportCsv}>
                Exportar CSV ↓
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void action(
                    { action: "lock", locked: !state.locked },
                    state.locked
                      ? "Reservas abiertas."
                      : "Reservas cerradas. Organización puede seguir editando.",
                  )
                }
              >
                {state.locked ? "Abrir reservas" : "Cerrar reservas"}
              </button>
              <button
                className="quiet"
                disabled={busy}
                onClick={async () => {
                  await action({ action: "logout" }, "");
                }}
              >
                Salir
              </button>
            </div>
          </div>
          {state.locked && (
            <Notice message="Reservas cerradas para competidores. Organización puede seguir editando." />
          )}
          <section>
            <h2>Slots garantizados por competidor</h2>
            <p>El límite es el total por persona. Subilo de 2 a 4, luego a 6, para habilitar más lugares por etapas. Reducirlo conserva las reservas existentes.</p>
            <LimitForm key={state.maxSlots} value={state.maxSlots} busy={busy} onSave={(maxSlots) => action({ action: "limit", maxSlots }, "Límite actualizado.")} />
          </section>
          <section>
            <div className="section-heading">
              <h2>Cupos por Slot</h2>
              <small>Reducir el cupo conserva las reservas existentes.</small>
            </div>
            <div className="capacities">
              {state.slots.map((slot) => (
                <CapacityForm
                  key={slot.id}
                  slot={slot}
                  busy={busy}
                  onSave={(slotId, capacity) =>
                    action({ action: "capacity", slotId, capacity })
                  }
                />
              ))}
            </div>
          </section>
          <section className="matrix-section">
            <div className="section-heading">
              <h2>Todos los horarios</h2>
              <label className="search-label">
                <span className="sr-only">Buscar competidor</span>
                <input
                  type="search"
                  placeholder="Buscar nombre o WCA ID…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </div>
            <p className="hint">
              Tocá una persona o una celda para editar su horario. Deslizá la
              tabla para ver todos los Slots.
            </p>
            <div
              className="matrix-wrap"
              tabIndex={0}
              aria-label="Horarios de competidores"
            >
              <table>
                <caption className="sr-only">
                  Matriz de competidores y Slots
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Competidor</th>
                    {state.slots.map((slot) => (
                      <th scope="col" key={slot.id}>
                        {timeLabel(slot.startsAt)}
                        <small>
                          {slot.occupancy}/{slot.capacity}
                        </small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.competitors
                    .filter((p) =>
                      `${p.name} ${p.wcaId || ""}`
                        .toLocaleLowerCase()
                        .includes(search.toLocaleLowerCase()),
                    )
                    .map((p) => (
                      <tr
                        key={p.id}
                        className={p.id === selected ? "selected-row" : ""}
                      >
                        <th scope="row">
                          <button
                            disabled={busy}
                            onClick={() => setSelected(p.id)}
                          >
                            {p.name}
                            <small>{p.wcaId || "Sin WCA ID"}</small>
                          </button>
                        </th>
                        {state.slots.map((slot) => {
                          const booking = state.bookings.find(
                            (b) =>
                              b.competitorId === p.id && b.slotId === slot.id,
                          );
                          return (
                            <td key={slot.id}>
                              <button
                                disabled={busy}
                                className={
                                  booking ? "cell-booked" : "cell-empty"
                                }
                                aria-label={`${p.name}, ${timeLabel(slot.startsAt)}, ${booking ? label(booking) : "sin reserva"}`}
                                onClick={() => {
                                  setSelected(p.id);
                                  setTimeout(
                                    () =>
                                      document
                                        .getElementById(`admin-${slot.id}`)
                                        ?.scrollIntoView({
                                          behavior: "smooth",
                                          block: "center",
                                        }),
                                    0,
                                  );
                                }}
                              >
                                {label(booking)}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </tbody>
              </table>
              {!state.competitors.length && (
                <p className="empty">
                  Todavía no hay competidores. Importá el roster o agregá un
                  nombre abajo.
                </p>
              )}
            </div>
          </section>
          <section className="personal-editor">
            <div className="section-heading">
              <h2>
                {person
                  ? `Horario de ${person.name}`
                  : "Ver o agregar una persona"}
              </h2>
              {person && (
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() => setSelected("")}
                >
                  Cerrar horario
                </button>
              )}
            </div>
            <Identity compact onIdentify={identify} busy={busy} />
            {person && (
              <div className="slots">
                {selectedSlots.map((slot) => (
                  <div id={`admin-${slot.id}`} key={`${selected}-${slot.id}`}>
                    <SlotCard
                      slot={slot}
                      events={state.events}
                      enabled
                      locked={false}
                      busy={busy}
                      limitReached={selectedSlots.filter((s) => s.booking).length >= state.maxSlots}
                      onSave={(slotId, eventId) =>
                        action({
                          action: "save",
                          competitorId: selected,
                          slotId,
                          eventId,
                        })
                      }
                      onRemove={(slotId) =>
                        action({
                          action: "remove",
                          competitorId: selected,
                          slotId,
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
          <details className="roster-tools">
            <summary>Importar competidores</summary>
            <p>
              Agrega los inscriptos aceptados sin borrar reservas. Todos pueden
              elegir cualquier evento. También se puede entrar directamente con
              un nombre.
            </p>
            <div className="actions">
              <button
                disabled={busy}
                onClick={() =>
                  void action(
                    { action: "importWca" },
                    "Roster de WCA importado.",
                  )
                }
              >
                Importar desde WCA
              </button>
              <label className="file-label">
                Importar JSON
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={busy}
                  onChange={async (e) => {
                    const input = e.currentTarget;
                    const file = input.files?.[0];
                    if (!file) return;
                    try {
                      if (file.size > 200_000)
                        throw new Error("El archivo supera los 200 KB.");
                      await action(
                        {
                          action: "importRoster",
                          records: JSON.parse(await file.text()),
                        },
                        "Roster importado.",
                      );
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      input.value = "";
                    }
                  }}
                />
              </label>
            </div>
            <p className="hint">
              Formato:{" "}
              <code>{'[{"name":"Nombre Apellido","wcaId":null}]'}</code>
            </p>
          </details>
        </>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
