import {
  authCookie,
  createCompetitorSession,
  finishWcaLogin,
  logoutCompetitor,
  sessionCompetitor,
  startWcaLogin,
  wcaConfigured,
  WcaLoginError,
} from "./wca-auth.js";
import { BookingError } from "../domain.js";
import { competition } from "../config.js";
import {
  adminCookie,
  checkPassword,
  clearAdminCookie,
  isAdmin,
} from "./auth.js";
import { database } from "./db.js";
import { Planner } from "./service.js";

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
export async function handle(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const admin = isAdmin(request.headers.get("cookie"));
    const service = new Planner(database());
    if (request.method === "GET") {
      const action = url.searchParams.get("action");
      if (action === "wcaLogin") {
        if (!wcaConfigured())
          return new Response(null, {
            status: 302,
            headers: {
              Location: "/?loginError=configuration",
              "Cache-Control": "no-store",
            },
          });
        return await startWcaLogin(database());
      }
      if (action === "wcaCallback") {
        const headers = new Headers({
          Location: "/",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        headers.append("Set-Cookie", authCookie("ronda_oauth", "", 0));
        try {
          const profile = await finishWcaLogin(database(), request);
          const person = await service.identifyWca(profile);
          headers.append(
            "Set-Cookie",
            await createCompetitorSession(database(), person.id),
          );
        } catch (error) {
          const reason =
            error instanceof WcaLoginError
              ? error.message
              : error instanceof BookingError &&
                  error.code === "ACCOUNT_CONFLICT"
                ? "account_conflict"
                : "unavailable";
          headers.set("Location", `/?loginError=${encodeURIComponent(reason)}`);
        }
        return new Response(null, { status: 302, headers });
      }
      if (action === "admin" && !admin)
        return json(
          { error: "Ingresá la contraseña de la organización." },
          401,
        );
      if (action && action !== "admin")
        return json({ error: "La acción solicitada no es válida." }, 400);
      const personId =
        action === "admin"
          ? null
          : await sessionCompetitor(database(), request.headers.get("cookie"));
      return json({
        ...(await service.state(personId, action === "admin")),
        wcaLoginAvailable: wcaConfigured(),
      });
    }
    if (request.method !== "POST")
      return json({ error: "Método no permitido." }, 405, {
        Allow: "GET, POST",
      });
    const origin = request.headers.get("origin");
    if (
      (origin && origin !== url.origin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return json({ error: "Origen no permitido." }, 403);
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      return json({ error: "Enviá la solicitud en formato JSON." }, 415);
    const raw = await request.text();
    if (raw.length > 200_000)
      return json({ error: "Archivo demasiado grande." }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(
        { error: "El contenido no tiene un formato JSON válido." },
        400,
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return json({ error: "Solicitud inválida." }, 400);
    if (body.action === "login") {
      if (!checkPassword(body.password))
        return json({ error: "Contraseña incorrecta." }, 401);
      return json({ ok: true }, 200, { "Set-Cookie": adminCookie() });
    }
    if (body.action === "logout")
      return json({ ok: true }, 200, { "Set-Cookie": clearAdminCookie() });
    const adminActions = [
      "identify",
      "capacity",
      "limit",
      "lock",
      "importWca",
      "importRoster",
    ];
    if (
      (adminActions.includes(String(body.action)) || body.asAdmin === true) &&
      !admin
    )
      return json({ error: "Tu sesión terminó. Volvé a ingresar." }, 401);
    if (body.action === "competitorLogout")
      return json({ ok: true }, 200, {
        "Set-Cookie": await logoutCompetitor(
          database(),
          request.headers.get("cookie"),
        ),
      });
    if (
      (body.action === "save" || body.action === "remove") &&
      body.asAdmin !== true
    ) {
      const personId = await sessionCompetitor(
        database(),
        request.headers.get("cookie"),
      );
      if (!personId)
        return json(
          {
            error: "Ingresá con tu cuenta de la WCA para reservar tus Slots.",
            code: "LOGIN_REQUIRED",
          },
          401,
        );
      if (body.competitorId !== undefined && body.competitorId !== personId)
        return json(
          {
            error: "Solo podés editar tus propias reservas.",
            code: "FORBIDDEN",
          },
          403,
        );
      body.competitorId = personId;
    }
    switch (body.action) {
      case "identify":
        return json(await service.identify(body.name));
      case "save":
        await service.save(body, admin && body.asAdmin === true);
        break;
      case "remove":
        await service.remove(body, admin && body.asAdmin === true);
        break;
      case "capacity":
        await service.capacity(body.slotId, body.capacity);
        break;
      case "limit":
        await service.limit(body.maxSlots);
        break;
      case "lock":
        await service.lock(body.locked);
        break;
      case "importRoster":
        return json({ count: await service.importRoster(body.records) });
      case "importWca": {
        const response = await fetch(
          `https://www.worldcubeassociation.org/api/v0/competitions/${competition.id}/wcif/public`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (!response.ok)
          return json(
            {
              error:
                "No pudimos consultar la lista de inscriptos de la WCA. Podés importar un archivo JSON.",
            },
            502,
          );
        const wcif = await response.json();
        if (!Array.isArray(wcif.persons))
          return json(
            {
              error:
                "La respuesta de la WCA no contiene una lista de competidores.",
            },
            502,
          );
        return json({
          count: await service.importRoster(
            wcif.persons
              .filter(
                (p: {
                  registration?: { status?: string; isCompeting?: boolean };
                }) =>
                  p.registration?.status === "accepted" &&
                  p.registration?.isCompeting !== false,
              )
              .map(
                (p: { name: string; wcaId?: string; wcaUserId?: number }) => ({
                  name: p.name,
                  wcaId: p.wcaId,
                  wcaUserId: p.wcaUserId,
                }),
              ),
          ),
        });
      }
      default:
        return json({ error: "La acción solicitada no es válida." }, 400);
    }
    return json({ ok: true });
  } catch (error) {
    if (error instanceof BookingError)
      return json(
        { error: error.message, code: error.code },
        ["SLOT_FULL", "LOCKED"].includes(error.code) ? 409 : 400,
      );
    if (error instanceof Error && error.message === "BOOKING_LIMIT")
      return json(
        {
          error:
            "Ya alcanzaste el límite de Slots garantizados. Podés cambiar o liberar tus reservas, o esperar a que la organización habilite más lugares.",
          code: "BOOKING_LIMIT",
        },
        409,
      );
    if (error instanceof Error && error.message === "SLOT_FULL")
      return json(
        {
          error: "Este Slot acaba de completarse. Elegí otro.",
          code: "SLOT_FULL",
        },
        409,
      );
    console.error(
      "Planner request failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    return json(
      {
        error:
          "No pudimos completar la solicitud. Intentá de nuevo en unos segundos.",
      },
      500,
    );
  }
}
