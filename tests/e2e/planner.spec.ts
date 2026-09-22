import { test, expect } from "@playwright/test";
import pg from "pg";
import { Planner } from "../../src/server/service.ts";
import {
  createCompetitorSession,
  cookieValue,
} from "../../src/server/wca-auth.ts";
import { mkdir, readFile } from "node:fs/promises";

test("mobile authenticated booking, waves, logout, and organizer controls", async ({
  page,
  browser,
  playwright,
}) => {
  test.setTimeout(90_000);
  const api = await playwright.request.newContext({
    baseURL: "http://127.0.0.1:5173",
  });
  expect(
    (
      await api.post("/api/planner", {
        data: { action: "login", password: "browser-test-password" },
      })
    ).ok(),
  ).toBeTruthy();
  for (const slotId of ["slot-a", "slot-b", "slot-c"])
    expect(
      (
        await api.post("/api/planner", {
          data: { action: "capacity", slotId, capacity: 1 },
        })
      ).ok(),
    ).toBeTruthy();
  await api.post("/api/planner", { data: { action: "lock", locked: false } });
  // Clear only test fixture bookings in these Slots, through the authorized API.
  const existing = await (await api.get("/api/planner?action=admin")).json();
  for (const booking of existing.bookings)
    await api.post("/api/planner", {
      data: { ...booking, action: "remove", asAdmin: true },
    });
  await api.post("/api/planner", { data: { action: "limit", maxSlots: 2 } });

  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const service = new Planner(pool);
  const accountId = Date.now();
  const name = `Álex Browser ${accountId}`;
  const person = await service.identifyWca({
    id: accountId,
    name,
    wcaId: null,
  });
  async function signInAs(id: string) {
    const cookie = await createCompetitorSession(pool, id);
    await page.context().addCookies([
      {
        name: "ronda_competitor",
        value: cookieValue(cookie, "ronda_competitor")!,
        url: "http://127.0.0.1:5173",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto("/");
  }
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?loginError=not_registered");
    await expect(page.getByRole("alert")).toContainText(
      "Todavía no figura una inscripción aceptada en la WCA",
    );
    await expect(
      page.getByRole("link", { name: "Inscribite en la página de la WCA" }),
    ).toHaveAttribute(
      "href",
      "https://www.worldcubeassociation.org/competitions/ElegiTuRondaBA2026/register",
    );
    await expect(page.getByLabel("Nombre y apellido o WCA ID")).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("hasta 5 minutos");
    await expect(
      page.getByRole("link", {
        name: "Volver a verificar mi inscripción",
      }),
    ).toHaveAttribute("href", "/api/planner?action=wcaLogin");
    await signInAs(person.id);
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    for (const id of ["slot-a", "slot-b"]) {
      const slot = page.locator(`#${id}`);
      await slot.getByRole("button", { name: "Elegir evento" }).click();
      await slot
        .getByRole("combobox", { name: "Evento", exact: true })
        .selectOption("555bf");
      await expect(slot.getByRole("radio")).toHaveCount(0);
      await slot.getByRole("button", { name: "Guardar lugar" }).click();
      await expect(slot.getByText("5BLD", { exact: true })).toBeVisible();
      if (id === "slot-a")
        await expect(
          page.getByText("Podés reservar hasta 1 Slot garantizado más.", {
            exact: false,
          }),
        ).toBeVisible();
    }
    await expect(
      page.locator("#slot-a").getByText("También en otro Slot"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Por ahora no tenés más Slots garantizados disponibles.",
        {
          exact: false,
        },
      ),
    ).toBeVisible();
    await expect(
      page
        .locator("#slot-c")
        .getByRole("button", { name: "Límite de Slots alcanzado" }),
    ).toBeDisabled();
    await api.post("/api/planner", { data: { action: "limit", maxSlots: 4 } });
    await page.reload();
    await expect(
      page.getByText("Podés reservar hasta 2 Slots garantizados más.", {
        exact: false,
      }),
    ).toBeVisible();
    await api.dispose();
    const fto = page.locator("#slot-c");
    await fto.getByRole("button", { name: "Elegir evento" }).click();
    await fto
      .getByRole("combobox", { name: "Evento", exact: true })
      .selectOption("fto");
    await expect(fto.getByRole("radio", { name: "Ronda 2" })).toHaveCount(0);
    await fto.getByRole("button", { name: "Guardar lugar" }).click();
    await expect(fto.getByText("FTO", { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page.locator("#slot-a").getByText("5BLD", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/competitor-mobile.png",
      fullPage: true,
    });

    await page
      .getByRole("button", { name: "Cerrar sesión", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Ingresá con tu cuenta de la WCA" }),
    ).toBeVisible();
    // Old localStorage identities must not restore authorization.
    await page.evaluate(
      (id) => localStorage.setItem("ronda-person", id),
      person.id,
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Ingresá con tu cuenta de la WCA" }),
    ).toBeVisible();
    const other = await service.identifyWca({
      id: accountId + 1,
      name: "Otra Persona Browser",
      wcaId: null,
    });
    await signInAs(other.id);
    await expect(
      page.locator("#slot-a").getByRole("button", { name: "Completo" }),
    ).toBeDisabled();
    await signInAs(person.id);
    await expect(
      page.locator("#slot-a").getByText("5BLD", { exact: true }),
    ).toBeVisible();

    const adminContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const admin = await adminContext.newPage();
    await admin.goto("/admin");
    await admin.getByLabel("Contraseña").fill("browser-test-password");
    await admin.getByRole("button", { name: "Ingresar", exact: true }).click();
    await expect(
      admin.getByRole("heading", { name: "Todos los horarios" }),
    ).toBeVisible();
    await admin.getByText("Importar competidores", { exact: true }).click();
    await admin.getByRole("button", { name: "Importar desde la WCA" }).click();
    await expect(admin.getByRole("status")).toContainText(
      "Se importó la lista de inscriptos de la WCA.",
    );
    await admin
      .getByLabel("Importar JSON")
      .setInputFiles({
        name: "competidores.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify([
            {
              name: "Persona Importada JSON",
              wcaId: "2026TEST09",
              wcaUserId: 990009,
            },
          ]),
        ),
      });
    await expect(admin.getByRole("status")).toContainText(
      "Se importó la lista de competidores.",
    );
    await expect(
      admin
        .getByRole("rowheader")
        .getByRole("button", { name: /Persona Importada JSON/ }),
    ).toBeVisible();
    const downloadPromise = admin.waitForEvent("download");
    await admin.getByRole("button", { name: "Exportar CSV" }).click();
    const csv = await readFile((await (await downloadPromise).path())!, "utf8");
    expect(csv).toContain(name);
    expect(csv).toContain('"5BLD"');
    expect(csv).not.toMatch(/(?:5BLD|FTO) R[12]/);
    await admin.getByLabel("Máximo de Slots por competidor").fill("6");
    await admin.getByRole("button", { name: "Guardar límite" }).click();
    await expect(admin.getByText("Límite actualizado.")).toBeVisible();
    await admin.getByLabel("Capacidad de Slot A").fill("0");
    await admin
      .locator(".capacity-card")
      .filter({ hasText: "Slot A" })
      .getByRole("button", { name: "Guardar" })
      .click();
    await expect(
      admin.locator(".capacity-card").filter({ hasText: "Slot A" }),
    ).toContainText("Cupo excedido");
    await admin
      .getByRole("rowheader")
      .getByRole("button", { name: new RegExp(name) })
      .click();
    const personal = admin.locator("#admin-slot-a");
    await personal
      .getByRole("button", { name: "Cambiar", exact: true })
      .click();
    await personal
      .getByRole("combobox", { name: "Evento", exact: true })
      .selectOption("222");
    await expect(personal.getByRole("radio")).toHaveCount(0);
    await personal.getByRole("button", { name: "Guardar lugar" }).click();
    await expect(personal.getByText("2x2", { exact: true })).toBeVisible();
    await admin.screenshot({
      path: "test-results/admin-desktop.png",
      fullPage: true,
    });
    await admin
      .getByRole("button", { name: "Cerrar reservas", exact: true })
      .click();
    await expect(
      admin.getByRole("button", { name: "Abrir reservas", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page
        .locator("#slot-a")
        .getByRole("button", { name: "Cambiar", exact: true }),
    ).toBeDisabled();
    await personal
      .getByRole("button", { name: "Liberar lugar", exact: true })
      .click();
    await personal
      .getByRole("button", { name: "Sí, liberar", exact: true })
      .click();
    await expect(personal.getByText("2x2", { exact: true })).toHaveCount(0);
    await admin
      .getByRole("button", { name: "Abrir reservas", exact: true })
      .click();
    await admin.getByRole("button", { name: "Salir", exact: true }).click();
    await expect(
      admin.getByRole("heading", { name: "Acceso para la organización" }),
    ).toBeVisible();
    await adminContext.close();
  } finally {
    await pool.end();
  }
});
