import { BookingError } from "../domain.ts";
import { competition } from "../config.ts";
import {
  adminCookie,
  checkPassword,
  clearAdminCookie,
  isAdmin,
} from "./auth.ts";
import { database } from "./db.ts";
import { Planner } from "./service.ts";

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
      if (action === "admin" && !admin)
        return json({ error: "Ingresá la contraseña de organización." }, 401);
      if (action && action !== "admin")
        return json({ error: "Acción inválida." }, 400);
      return json(
        await service.state(
          url.searchParams.get("competitorId"),
          action === "admin",
        ),
      );
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
      return json({ error: "Usá JSON." }, 415);
    const raw = await request.text();
    if (raw.length > 200_000)
      return json({ error: "Archivo demasiado grande." }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "JSON inválido." }, 400);
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
    const adminActions = ["capacity", "lock", "importWca", "importRoster"];
    if (
      (adminActions.includes(String(body.action)) || body.asAdmin === true) &&
      !admin
    )
      return json({ error: "Tu sesión terminó. Volvé a ingresar." }, 401);
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
            { error: "No se pudo leer WCA. Podés importar JSON." },
            502,
          );
        const wcif = await response.json();
        if (!Array.isArray(wcif.persons))
          return json(
            { error: "La respuesta de WCA no contiene competidores." },
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
              .map((p: { name: string; wcaId?: string }) => ({
                name: p.name,
                wcaId: p.wcaId,
              })),
          ),
        });
      }
      default:
        return json({ error: "Acción inválida." }, 400);
    }
    return json({ ok: true });
  } catch (error) {
    if (error instanceof BookingError)
      return json(
        { error: error.message, code: error.code },
        ["SLOT_FULL", "LOCKED"].includes(error.code) ? 409 : 400,
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
